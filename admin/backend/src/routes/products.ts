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
import pino from 'pino'
import axios from 'axios'

const logger = pino()
const router = express.Router()

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

    // валидация обязательных полей
    if (!productData.title || !productData.slug || !productData.category) {
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

    // проверка уникальности артикула
    const allProducts = await fetchProductsFromSheet(sheetId)
    if (productData.article) {
      const articleExists = allProducts.some(p => p.article === productData.article)
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
    
    // проверяем что лист существует и нормализуем имя
    const sheetNames = process.env.SHEET_NAMES?.split(',') || ['ягоды', 'выпечка', 'pets', 'шея', 'руки', 'уши', 'сертификаты']
    const normalizedCategory = sheetNames.find(name => name.trim().toLowerCase() === productData.category.toLowerCase())
    if (!normalizedCategory) {
      logger.warn({ category: productData.category }, 'категория не найдена')
      return res.status(400).json({ error: 'invalid_category' })
    }

    // формируем товар для сохранения
    const product = {
      slug: productData.slug.trim(),
      title: productData.title.trim(),
      description: productData.description?.trim() || undefined,
      category: normalizedCategory,
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
      article: productData.article?.trim() || undefined
    }

    await appendProductToSheet(auth, sheetId, normalizedCategory, product)

    logger.info({ slug: product.slug, article: product.article }, 'товар добавлен')
    
    // вызываем импорт в основном бэкенде для обновления мини-апки
    await triggerBackendImport()
    
    res.json({ success: true, product })
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

    // валидация обязательных полей
    if (!productData.title || !productData.slug || !productData.category) {
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
    
    // проверяем что лист существует и нормализуем имя
    const sheetNames = process.env.SHEET_NAMES?.split(',') || ['ягоды', 'выпечка', 'pets', 'шея', 'руки', 'уши', 'сертификаты']
    const normalizedCategory = sheetNames.find(name => name.trim().toLowerCase() === productData.category.toLowerCase())
    if (!normalizedCategory) {
      logger.warn({ category: productData.category }, 'категория не найдена')
      return res.status(400).json({ error: 'invalid_category' })
    }

    // формируем товар для сохранения
    const product = {
      slug: productData.slug.trim(),
      title: productData.title.trim(),
      description: productData.description?.trim() || undefined,
      category: normalizedCategory,
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
      article: oldProduct.article // артикул не меняется
    }

    // если категория изменилась, нужно удалить из старого листа и добавить в новый
    if (oldProduct.category.toLowerCase() !== normalizedCategory.toLowerCase()) {
      // нормализуем имя старой категории для удаления
      const normalizedOldCategory = normalizeSheetName(oldProduct.category)
      await deleteProductFromSheet(auth, sheetId, normalizedOldCategory, oldSlug)
      await appendProductToSheet(auth, sheetId, normalizedCategory, product)
    } else {
      await updateProductInSheet(auth, sheetId, normalizedCategory, oldSlug, product)
    }

    logger.info({ oldSlug, newSlug: product.slug }, 'товар обновлен')
    
    // вызываем импорт в основном бэкенде для обновления мини-апки
    await triggerBackendImport()
    
    res.json({ success: true, product })
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

// удаление товара
router.delete('/:slug', async (req, res) => {
  try {
    const sheetId = process.env.GOOGLE_SHEET_ID
    if (!sheetId) {
      return res.status(500).json({ error: 'GOOGLE_SHEET_ID not configured' })
    }

    const slug = req.params.slug

    // находим товар
    const allProducts = await fetchProductsFromSheet(sheetId)
    const product = allProducts.find(p => p.slug === slug)
    if (!product) {
      return res.status(404).json({ error: 'product_not_found' })
    }

    const auth = getAuthFromEnv()
    // нормализуем имя категории для удаления
    const normalizedCategory = normalizeSheetName(product.category)
    await deleteProductFromSheet(auth, sheetId, normalizedCategory, slug)

    logger.info({ slug }, 'товар удален')
    
    // вызываем импорт в основном бэкенде для обновления мини-апки
    await triggerBackendImport()
    
    res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка удаления товара')
    res.status(500).json({ error: error?.message || 'failed_to_delete_product' })
  }
})

export default router

