import express from 'express'
import { requireAuth } from '../auth.js'
import { fetchProductsFromSheet } from '../sheets.js'
import {
  getAuthFromEnv,
  appendProductToSheet,
  updateProductInSheet,
  deleteProductFromSheet,
  normalizeSheetName,
  reorderProductsInSheet
} from '../sheets-utils.js'
import { fetchCategoriesFromSheet } from '../categories-utils.js'
import pino from 'pino'
import axios from 'axios'

const logger = pino()
const router = express.Router()

// артикул в таблице хранится как число (100, 1) — нормализуем к "0100", "0001" для сравнения и записи
function normalizeArticle(article: string | undefined): string | undefined {
  if (article == null || String(article).trim() === '') return undefined
  const s = String(article).trim()
  const n = parseInt(s, 10)
  if (!Number.isFinite(n) || n < 0 || n > 9999) return undefined
  return String(n).padStart(4, '0')
}

// функция для вызова импорта в основном бэкенде
async function triggerBackendImport() {
  try {
    const backendUrl = process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com'
    const adminKey = process.env.ADMIN_IMPORT_KEY
    
    if (adminKey) {
      await axios.post(`${backendUrl}/admin/import/sheets`, {}, {
        headers: { 'x-admin-key': adminKey },
        timeout: 30000
      })
      logger.info('импорт товаров в основном бэкенде вызван')
    } else {
      logger.warn('ADMIN_IMPORT_KEY не задан, импорт в основном бэкенде пропущен')
    }
  } catch (error: any) {
    // не блокируем выполнение, если импорт не удался
    logger.warn({ error: error?.message }, 'не удалось вызвать импорт в основном бэкенде')
  }
}

// все роуты требуют авторизации
router.use(requireAuth)

// получение списка всех товаров
router.get('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }
    
    logger.info('загрузка товаров из Google Sheets')
    const products = await fetchProductsFromSheet(sheetId)
    // товары уже в порядке строк таблицы, сортировка не нужна
    
    logger.info({ count: products.length }, 'товары загружены')
    res.json({ products })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки товаров')
    res.status(500).json({ error: 'failed_to_load_products' })
  }
})

// добавление товара
router.post('/', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const productData = req.body

    // категории: массив или одно значение
    const categoriesRaw = productData.categories != null
      ? (Array.isArray(productData.categories) ? productData.categories : [productData.category])
      : (productData.category != null ? [productData.category] : [])
    const categoryList = categoriesRaw.filter((c: any) => c != null && String(c).trim())
    if (!productData.title || !productData.slug || categoryList.length === 0) {
      return res.status(400).json({ error: 'missing_required_fields' })
    }

    // валидация длины полей для защиты от DoS
    if (productData.title.length > 200) {
      return res.status(400).json({ error: 'title_too_long' })
    }
    if (productData.slug.length > 100) {
      return res.status(400).json({ error: 'slug_too_long' })
    }
    if (productData.description && productData.description.length > 5000) {
      return res.status(400).json({ error: 'description_too_long' })
    }
    if (productData.badge_text && productData.badge_text.length > 50) {
      return res.status(400).json({ error: 'badge_text_too_long' })
    }
    if (productData.article && productData.article.length > 50) {
      return res.status(400).json({ error: 'article_too_long' })
    }

    // валидация slug - только латиница, цифры, дефисы и подчеркивания
    if (!/^[a-z0-9_-]+$/.test(productData.slug)) {
      return res.status(400).json({ error: 'invalid_slug_format' })
    }

    if (!productData.price_rub || productData.price_rub <= 0) {
      return res.status(400).json({ error: 'invalid_price' })
    }

    // валидация цены со скидкой
    if (productData.discount_price_rub !== undefined && productData.discount_price_rub !== null) {
      const discountPrice = Number(productData.discount_price_rub)
      if (!Number.isFinite(discountPrice) || discountPrice <= 0) {
        return res.status(400).json({ error: 'invalid_discount_price' })
      }
      if (discountPrice >= productData.price_rub) {
        return res.status(400).json({ error: 'discount_price_must_be_less' })
      }
    }

    // фото необязательное, но если передано - проверяем что это массив
    if (productData.images !== undefined && !Array.isArray(productData.images)) {
      return res.status(400).json({ error: 'invalid_images' })
    }
    
    // валидация URL изображений и ограничение количества
    if (productData.images && Array.isArray(productData.images)) {
      if (productData.images.length > 20) {
        return res.status(400).json({ error: 'too_many_images' })
      }
      // проверяем что все элементы - строки и валидные URL
      for (const img of productData.images) {
        if (typeof img !== 'string' || img.length > 500) {
          return res.status(400).json({ error: 'invalid_image_url' })
        }
        try {
          new URL(img)
        } catch {
          return res.status(400).json({ error: 'invalid_image_url_format' })
        }
      }
    }

    // проверка уникальности артикула (сравниваем в нормализованном виде: 100 и 0100 — один артикул)
    const allProducts = await fetchProductsFromSheet(sheetId)
    const newArticleNorm = normalizeArticle(productData.article)
    if (newArticleNorm) {
      const articleExists = allProducts.some(p => normalizeArticle(p.article) === newArticleNorm)
      if (articleExists) {
        return res.status(400).json({ error: 'article_already_exists' })
      }
    }

    // проверка уникальности slug
    const slugExists = allProducts.some(p => p.slug === productData.slug)
    if (slugExists) {
      return res.status(400).json({ error: 'slug_already_exists' })
    }

    const auth = getAuthFromEnv()
    
    // проверяем что все категории есть в листе categories
    const categoriesFromSheet = await fetchCategoriesFromSheet(sheetId)
    const sheetNames = categoriesFromSheet.map((c) => c.key)
    const normalizedCategories: string[] = []
    for (const cat of categoryList) {
      const norm = sheetNames.find((name: string) => name.trim().toLowerCase() === String(cat).trim().toLowerCase())
      if (!norm) {
        logger.warn({ category: cat }, 'категория не найдена')
        return res.status(400).json({ error: 'invalid_category' })
      }
      if (!normalizedCategories.includes(norm)) normalizedCategories.push(norm)
    }

    // формируем товар для сохранения
    const product = {
      slug: productData.slug.trim(),
      title: productData.title.trim(),
      description: productData.description?.trim() || undefined,
      category: normalizedCategories[0],
      categories: normalizedCategories,
      price_rub: Number(productData.price_rub),
      discount_price_rub: productData.discount_price_rub !== undefined && productData.discount_price_rub !== null
        ? Number(productData.discount_price_rub)
        : undefined,
      badge_text: productData.badge_text?.trim() || undefined,
      images: productData.images && Array.isArray(productData.images)
        ? productData.images.filter((img: string) => img.trim())
        : [],
      active: productData.active !== undefined ? Boolean(productData.active) : true,
      stock: productData.stock !== undefined ? Number(productData.stock) : undefined,
      article: newArticleNorm || productData.article?.trim() || undefined
    }

    for (const cat of normalizedCategories) {
      await appendProductToSheet(auth, sheetId, cat, { ...product, category: cat })
    }

    logger.info({ slug: product.slug, categories: normalizedCategories }, 'товар добавлен')
    
    await triggerBackendImport()
    
    res.json({ success: true, product: { ...product, categories: normalizedCategories } })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка добавления товара')
    res.status(500).json({ error: error?.message || 'failed_to_create_product' })
  }
})

// обновление товара
router.put('/:slug', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const oldSlug = req.params.slug
    const productData = req.body

    // категории: массив или одно значение
    const categoriesRawEdit = productData.categories != null
      ? (Array.isArray(productData.categories) ? productData.categories : [productData.category])
      : (productData.category != null ? [productData.category] : [])
    const categoryListEdit = categoriesRawEdit.filter((c: any) => c != null && String(c).trim())
    if (!productData.title || !productData.slug || categoryListEdit.length === 0) {
      return res.status(400).json({ error: 'missing_required_fields' })
    }

    // валидация длины полей для защиты от DoS
    if (productData.title.length > 500) {
      return res.status(400).json({ error: 'title_too_long' })
    }
    if (productData.slug.length > 50) {
      return res.status(400).json({ error: 'slug_too_long' })
    }
    if (productData.description && productData.description.length > 1000) {
      return res.status(400).json({ error: 'description_too_long' })
    }
    if (productData.badge_text && productData.badge_text.length > 50) {
      return res.status(400).json({ error: 'badge_text_too_long' })
    }
    if (productData.article && productData.article.length > 50) {
      return res.status(400).json({ error: 'article_too_long' })
    }

    // валидация slug - только латиница, цифры, дефисы и подчеркивания
    if (!/^[a-z0-9_-]+$/.test(productData.slug)) {
      return res.status(400).json({ error: 'invalid_slug_format' })
    }

    if (!productData.price_rub || productData.price_rub <= 0) {
      return res.status(400).json({ error: 'invalid_price' })
    }

    // валидация цены со скидкой
    if (productData.discount_price_rub !== undefined && productData.discount_price_rub !== null) {
      const discountPrice = Number(productData.discount_price_rub)
      if (!Number.isFinite(discountPrice) || discountPrice <= 0) {
        return res.status(400).json({ error: 'invalid_discount_price' })
      }
      if (discountPrice >= productData.price_rub) {
        return res.status(400).json({ error: 'discount_price_must_be_less' })
      }
    }

    // фото необязательное, но если передано - проверяем что это массив
    if (productData.images !== undefined && !Array.isArray(productData.images)) {
      return res.status(400).json({ error: 'invalid_images' })
    }
    
    // валидация URL изображений и ограничение количества
    if (productData.images && Array.isArray(productData.images)) {
      if (productData.images.length > 20) {
        return res.status(400).json({ error: 'too_many_images' })
      }
      // проверяем что все элементы - строки и валидные URL
      for (const img of productData.images) {
        if (typeof img !== 'string' || img.length > 500) {
          return res.status(400).json({ error: 'invalid_image_url' })
        }
        try {
          new URL(img)
        } catch {
          return res.status(400).json({ error: 'invalid_image_url_format' })
        }
      }
    }

    // находим старый товар
    const allProducts = await fetchProductsFromSheet(sheetId)
    const oldProduct = allProducts.find(p => p.slug === oldSlug)
    if (!oldProduct) {
      return res.status(404).json({ error: 'product_not_found' })
    }

    // проверка уникальности slug (если изменился)
    if (productData.slug !== oldSlug) {
      const slugExists = allProducts.some(p => p.slug === productData.slug && p.slug !== oldSlug)
      if (slugExists) {
        return res.status(400).json({ error: 'slug_already_exists' })
      }
    }

    const auth = getAuthFromEnv()
    
    const categoriesFromSheetEdit = await fetchCategoriesFromSheet(sheetId)
    const sheetNamesEdit = categoriesFromSheetEdit.map((c) => c.key)
    const normalizedCategoriesEdit: string[] = []
    for (const cat of categoryListEdit) {
      const norm = sheetNamesEdit.find((name: string) => name.trim().toLowerCase() === String(cat).trim().toLowerCase())
      if (!norm) {
        return res.status(400).json({ error: 'invalid_category' })
      }
      if (!normalizedCategoriesEdit.includes(norm)) normalizedCategoriesEdit.push(norm)
    }

    const product = {
      slug: productData.slug.trim(),
      title: productData.title.trim(),
      description: productData.description?.trim() || undefined,
      category: normalizedCategoriesEdit[0],
      categories: normalizedCategoriesEdit,
      price_rub: Number(productData.price_rub),
      discount_price_rub: productData.discount_price_rub !== undefined && productData.discount_price_rub !== null
        ? Number(productData.discount_price_rub)
        : undefined,
      badge_text: productData.badge_text?.trim() || undefined,
      images: productData.images && Array.isArray(productData.images)
        ? productData.images.filter((img: string) => img.trim())
        : [],
      active: productData.active !== undefined ? Boolean(productData.active) : true,
      stock: productData.stock !== undefined ? Number(productData.stock) : undefined,
      article: oldProduct.article
    }

    const oldCategories = oldProduct.categories || [oldProduct.category]
    const toRemove = oldCategories.filter((c: string) => !normalizedCategoriesEdit.includes(c))
    const toAdd = normalizedCategoriesEdit.filter((c: string) => !oldCategories.includes(c))
    const toUpdate = normalizedCategoriesEdit.filter((c: string) => oldCategories.includes(c))

    for (const cat of toRemove) {
      await deleteProductFromSheet(auth, sheetId, normalizeSheetName(cat), oldSlug)
    }
    for (const cat of toUpdate) {
      await updateProductInSheet(auth, sheetId, normalizeSheetName(cat), oldSlug, { ...product, category: cat })
    }
    for (const cat of toAdd) {
      await appendProductToSheet(auth, sheetId, cat, { ...product, category: cat })
    }

    logger.info({ oldSlug, newSlug: product.slug, categories: normalizedCategoriesEdit }, 'товар обновлен')
    
    await triggerBackendImport()
    
    res.json({ success: true, product: { ...product, categories: normalizedCategoriesEdit } })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка обновления товара')
    res.status(500).json({ error: error?.message || 'failed_to_update_product' })
  }
})

// переупорядочивание товаров в категории
router.post('/reorder', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const { category, slugs } = req.body
    
    if (!category || !Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({ error: 'invalid_request' })
    }

    const auth = getAuthFromEnv()
    const normalizedCategory = normalizeSheetName(category)
    
    await reorderProductsInSheet(auth, sheetId, normalizedCategory, slugs)
    
    logger.info({ category: normalizedCategory, count: slugs.length }, 'порядок товаров обновлен')
    
    // вызываем импорт в основном бэкенде для обновления мини-апки
    await triggerBackendImport()
    
    res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка переупорядочивания товаров')
    res.status(500).json({ error: error?.message || 'failed_to_reorder_products' })
  }
})

// удаление товара (из всех категорий или только из одной)
// query: ?category=key — удалить только из этой категории; без параметра — из всех
router.delete('/:slug', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const slug = req.params.slug
    const onlyCategory = typeof req.query.category === 'string' ? req.query.category.trim() : null

    const allProducts = await fetchProductsFromSheet(sheetId)
    const product = allProducts.find(p => p.slug === slug)
    if (!product) {
      return res.status(404).json({ error: 'product_not_found' })
    }

    const productCategories = product.categories || [product.category]
    const categoriesToDelete = onlyCategory
      ? (productCategories.includes(onlyCategory) ? [onlyCategory] : [])
      : productCategories

    if (categoriesToDelete.length === 0) {
      return res.status(400).json({
        error: onlyCategory ? 'product_not_in_category' : 'product_has_no_categories'
      })
    }

    const auth = getAuthFromEnv()
    for (const cat of categoriesToDelete) {
      await deleteProductFromSheet(auth, sheetId, normalizeSheetName(cat), slug)
    }

    logger.info({ slug, categories: categoriesToDelete, onlyCategory: !!onlyCategory }, 'товар удален')
    
    await triggerBackendImport()
    
    res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка удаления товара')
    res.status(500).json({ error: error?.message || 'failed_to_delete_product' })
  }
})

export default router

