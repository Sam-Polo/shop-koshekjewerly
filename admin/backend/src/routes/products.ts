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

const logger = pino()
const router = express.Router()

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

    // валидация
    if (!productData.title || !productData.slug || !productData.category) {
      return res.status(400).json({ error: 'missing_required_fields' })
    }

    if (!productData.price_rub || productData.price_rub <= 0) {
      return res.status(400).json({ error: 'invalid_price' })
    }

    // фото необязательное, но если передано - проверяем что это массив
    if (productData.images !== undefined && !Array.isArray(productData.images)) {
      return res.status(400).json({ error: 'invalid_images' })
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
    const sheetNames = process.env.SHEET_NAMES?.split(',') || ['Ягоды', 'Шея', 'Руки', 'Уши', 'Сертификаты']
    const normalizedCategory = sheetNames.find(name => name.trim().toLowerCase() === productData.category.toLowerCase())
    if (!normalizedCategory) {
      return res.status(400).json({ error: 'invalid_category' })
    }

    // формируем товар для сохранения
    const product = {
      slug: productData.slug.trim(),
      title: productData.title.trim(),
      description: productData.description?.trim() || undefined,
      category: normalizedCategory,
      price_rub: Number(productData.price_rub),
      images: productData.images && Array.isArray(productData.images)
        ? productData.images.filter((img: string) => img.trim())
        : [],
      active: productData.active !== undefined ? Boolean(productData.active) : true,
      stock: productData.stock !== undefined ? Number(productData.stock) : undefined,
      article: productData.article?.trim() || undefined
    }

    await appendProductToSheet(auth, sheetId, normalizedCategory, product)

    logger.info({ slug: product.slug, article: product.article }, 'товар добавлен')
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

    // валидация
    if (!productData.title || !productData.slug || !productData.category) {
      return res.status(400).json({ error: 'missing_required_fields' })
    }

    if (!productData.price_rub || productData.price_rub <= 0) {
      return res.status(400).json({ error: 'invalid_price' })
    }

    // фото необязательное, но если передано - проверяем что это массив
    if (productData.images !== undefined && !Array.isArray(productData.images)) {
      return res.status(400).json({ error: 'invalid_images' })
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
    const sheetNames = process.env.SHEET_NAMES?.split(',') || ['Ягоды', 'Шея', 'Руки', 'Уши', 'Сертификаты']
    const normalizedCategory = sheetNames.find(name => name.trim().toLowerCase() === productData.category.toLowerCase())
    if (!normalizedCategory) {
      return res.status(400).json({ error: 'invalid_category' })
    }

    // формируем товар для сохранения
    const product = {
      slug: productData.slug.trim(),
      title: productData.title.trim(),
      description: productData.description?.trim() || undefined,
      category: normalizedCategory,
      price_rub: Number(productData.price_rub),
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
    res.json({ success: true })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка удаления товара')
    res.status(500).json({ error: error?.message || 'failed_to_delete_product' })
  }
})

export default router

