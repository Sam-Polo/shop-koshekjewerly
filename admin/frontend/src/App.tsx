import { useState, useEffect, useRef } from 'react'
import { api, getToken, saveToken, removeToken } from './api'
import { generateSlug, formatArticle, parseArticle } from './utils'
import PromocodesPage from './PromocodesPage'
import CategoriesPage from './CategoriesPage'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './App.css'

// компонент уведомлений
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose()
    }, 3000)
    return () => clearTimeout(timer)
  }, [onClose])

  return (
    <div className={`toast toast-${type}`}>
      {message}
      <button className="toast-close" onClick={onClose}>&times;</button>
    </div>
  )
}

// компонент подтверждения удаления (при нескольких категориях — выбор: из одной или везде)
function ConfirmModal({
  product,
  categories,
  onConfirm,
  onCancel
}: {
  product: Product
  categories: { key: string; title: string }[]
  onConfirm: (category?: string) => void
  onCancel: () => void
}) {
  const productCats = product.categories || [product.category]
  const multi = productCats.length > 1
  const getCategoryTitle = (key: string) => categories.find((c) => c.key === key)?.title || key

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Подтверждение</h3>
        <p>
          {multi
            ? `Товар «${product.title}» в нескольких категориях. Удалить только из одной или везде?`
            : `Вы уверены, что хотите удалить товар «${product.title}`}
          {multi ? '' : '»?'}
        </p>
        <div className="confirm-actions confirm-actions-column">
          {multi && (
            <>
              {productCats.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className="btn btn-confirm-secondary"
                  onClick={() => onConfirm(cat)}
                >
                  Удалить только из «{getCategoryTitle(cat)}»
                </button>
              ))}
              <button
                type="button"
                className="btn btn-confirm"
                onClick={() => onConfirm()}
              >
                Удалить из всех категорий
              </button>
            </>
          )}
          {!multi && (
            <button type="button" className="btn btn-confirm" onClick={() => onConfirm()}>
              Удалить
            </button>
          )}
          <button type="button" onClick={onCancel} className="btn btn-cancel">
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

type Product = {
  id?: string
  slug: string
  title: string
  description?: string
  category: string // первая категория (для совместимости)
  categories?: string[] // все категории товара
  price_rub: number
  discount_price_rub?: number // цена со скидкой (если заполнена - используется вместо price_rub)
  badge_text?: string // текст плашки (например, "СКИДКА", "НОВИНКА", "ПЕРСОНАЛИЗАЦИЯ")
  images: string[]
  active: boolean
  stock?: number
  article?: string
}

function LoginForm({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const data = await api.login(username, password)
      saveToken(data.token)
      onLogin()
    } catch (err: any) {
      setError(err.message || 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>Админ-панель</h1>
        <h2>KOSHEK JEWERLY</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Логин</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  )
}

type CategoryOption = { key: string; title: string }

function ProductsList({ onNavigate }: { onNavigate?: (page: 'products' | 'promocodes' | 'categories') => void }) {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [searchArticle, setSearchArticle] = useState<string>('')
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [isActivating, setIsActivating] = useState(false)
  const [isDeactivating, setIsDeactivating] = useState(false)
  const [selectedProductSlugs, setSelectedProductSlugs] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ product: Product } | null>(null)
  const [isReorderProductsMode, setIsReorderProductsMode] = useState(false)
  const [reorderedProductsByCategory, setReorderedProductsByCategory] = useState<Record<string, Product[]>>({})
  const [isSavingProductsOrder, setIsSavingProductsOrder] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [ordersClosed, setOrdersClosed] = useState(false)
  const [ordersCloseDate, setOrdersCloseDate] = useState<string>('')
  const [isOrdersSettingsModalOpen, setIsOrdersSettingsModalOpen] = useState(false)
  const [isSavingOrdersSettings, setIsSavingOrdersSettings] = useState(false)

  useEffect(() => {
    loadProducts()
    loadOrdersSettings()
    loadCategories()
  }, [])

  const loadCategories = async () => {
    try {
      const data = await api.getCategories()
      const list = (data.categories || []).map((c: { key: string; title: string }) => ({ key: c.key, title: c.title || c.key }))
      setCategories(list)
    } catch (err: any) {
      console.error('Ошибка загрузки категорий:', err)
    }
  }

  const loadOrdersSettings = async () => {
    try {
      const settings = await api.getOrdersSettings()
      setOrdersClosed(settings.ordersClosed || false)
      setOrdersCloseDate(settings.closeDate || '')
    } catch (error: any) {
      console.error('Ошибка загрузки настроек заказов:', error)
    }
  }

  const handleToggleOrdersStatus = () => {
    if (ordersClosed) {
      // если заказы закрыты - открываем простое подтверждающее окно
      setIsOrdersSettingsModalOpen(true)
    } else {
      // если заказы открыты - открываем модальное окно с полем для даты
      setIsOrdersSettingsModalOpen(true)
    }
  }

  const handleOpenOrders = async () => {
    try {
      setIsSavingOrdersSettings(true)
      await api.updateOrdersSettings({
        ordersClosed: false,
        closeDate: undefined // очищаем дату при открытии
      })
      // перезагружаем настройки из API, чтобы синхронизировать состояние
      await loadOrdersSettings()
      setIsOrdersSettingsModalOpen(false)
      setToast({ message: 'Заказы открыты', type: 'success' })
    } catch (error: any) {
      setToast({ message: error.message || 'Ошибка открытия заказов', type: 'error' })
    } finally {
      setIsSavingOrdersSettings(false)
    }
  }

  const handleSaveOrdersSettings = async () => {
    try {
      setIsSavingOrdersSettings(true)
      await api.updateOrdersSettings({
        ordersClosed: true,
        closeDate: ordersCloseDate || undefined
      })
      // перезагружаем настройки из API, чтобы синхронизировать состояние
      await loadOrdersSettings()
      setIsOrdersSettingsModalOpen(false)
      setToast({ message: 'Заказы закрыты', type: 'success' })
    } catch (error: any) {
      setToast({ message: error.message || 'Ошибка сохранения настроек', type: 'error' })
    } finally {
      setIsSavingOrdersSettings(false)
    }
  }

  const loadProducts = async (): Promise<Product[]> => {
    try {
      setLoading(true)
      setError('')
      const data = await api.getProducts()
      const productsList = data.products || []
      setProducts(productsList)
      setSelectedProductSlugs(new Set()) // сбрасываем выделение при обновлении
      return productsList
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки товаров')
      return []
    } finally {
      setLoading(false)
    }
  }

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type })
  }

  const handleDeleteClick = (product: Product) => {
    setDeleteConfirm({ product })
    setSelectedProduct(null) // закрываем карточку товара сразу
  }

  const handleDeleteConfirm = async (category?: string) => {
    if (!deleteConfirm) return

    const product = deleteConfirm.product
    setDeleteConfirm(null)

    try {
      await api.deleteProduct(product.slug, category)
      showToast(category ? 'Товар удалён из категории' : 'Товар успешно удален', 'success')
      await loadProducts()
    } catch (err: any) {
      showToast(err.message || 'Ошибка удаления товара', 'error')
    }
  }

  const handleToggleProductSelection = (slug: string) => {
    setSelectedProductSlugs(prev => {
      const newSet = new Set(prev)
      if (newSet.has(slug)) {
        newSet.delete(slug)
      } else {
        newSet.add(slug)
      }
      return newSet
    })
  }

  const handleDeactivateSelected = async () => {
    if (selectedProductSlugs.size === 0) {
      showToast('Выберите товары для отключения', 'error')
      return
    }

    setIsDeactivating(true)
    try {
      const promises = Array.from(selectedProductSlugs).map(slug => {
        const product = products.find(p => p.slug === slug)
        if (!product) return Promise.resolve()
        return api.updateProduct(slug, { ...product, active: false })
      })
      
      await Promise.all(promises)
      showToast(`Отключено товаров: ${selectedProductSlugs.size}`, 'success')
      await loadProducts()
      setSelectedProductSlugs(new Set())
    } catch (err: any) {
      showToast(err.message || 'Ошибка отключения товаров', 'error')
    } finally {
      setIsDeactivating(false)
    }
  }

  const handleActivateSelected = async () => {
    if (selectedProductSlugs.size === 0) {
      showToast('Выберите товары для включения', 'error')
      return
    }

    setIsActivating(true)
    try {
      const promises = Array.from(selectedProductSlugs).map(slug => {
        const product = products.find(p => p.slug === slug)
        if (!product) return Promise.resolve()
        return api.updateProduct(slug, { ...product, active: true })
      })
      
      await Promise.all(promises)
      showToast(`Включено товаров: ${selectedProductSlugs.size}`, 'success')
      await loadProducts()
      setSelectedProductSlugs(new Set())
    } catch (err: any) {
      showToast(err.message || 'Ошибка включения товаров', 'error')
    } finally {
      setIsActivating(false)
    }
  }


  const handleLogout = () => {
    removeToken()
    window.location.reload()
  }

  // категории для фильтра: из API; если пусто — из товаров (fallback)
  const categoriesForFilter = categories.length > 0
    ? categories.map((c) => c.key)
    : Array.from(new Set(products.flatMap((p) => p.categories || [p.category]))).sort()

  // фильтруем товары по категории и артикулу
  const filteredProducts = products.filter(p => {
    const productCats = p.categories || [p.category]
    const matchesCategory = selectedCategory === 'all' || productCats.includes(selectedCategory)
    const matchesArticle = !searchArticle.trim() ||
      (p.article && p.article.toLowerCase().includes(searchArticle.trim().toLowerCase()))
    return matchesCategory && matchesArticle
  })

  // группируем по категориям (товар может быть в нескольких секциях)
  const groupedProducts = filteredProducts.reduce((acc, product) => {
    const productCats = product.categories || [product.category]
    for (const cat of productCats) {
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(product)
    }
    return acc
  }, {} as Record<string, Product[]>)

  // отслеживание прокрутки для кнопки "вверх"
  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 300)
    }
    
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // функция прокрутки вверх (быстрая прокрутка)
  const scrollToTop = () => {
    const startPosition = window.scrollY
    const startTime = performance.now()
    const duration = 300 // уменьшено с ~500ms до 300ms для более быстрой прокрутки
    
    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      
      // easing функция для плавности (ease-out)
      const easeOut = 1 - Math.pow(1 - progress, 3)
      
      window.scrollTo(0, startPosition * (1 - easeOut))
      
      if (progress < 1) {
        requestAnimationFrame(animateScroll)
      }
    }
    
    requestAnimationFrame(animateScroll)
  }

  // синхронизируем reorderedProductsByCategory при изменении products
  useEffect(() => {
    if (isReorderProductsMode) {
      setReorderedProductsByCategory({ ...groupedProducts })
    }
  }, [products, isReorderProductsMode])

  // настройка сенсоров для drag-and-drop товаров
  const productsSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 0,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleStartReorderProducts = () => {
    setIsReorderProductsMode(true)
    setReorderedProductsByCategory({ ...groupedProducts })
  }

  const handleCancelReorderProducts = () => {
    setIsReorderProductsMode(false)
    setReorderedProductsByCategory({})
  }

  const handleSaveProductsOrder = async () => {
    setIsSavingProductsOrder(true)
    try {
      // сохраняем порядок товаров через перемещение строк в таблице
      const reorderPromises: Promise<void>[] = []
      
      Object.entries(reorderedProductsByCategory).forEach(([category, categoryProducts]) => {
        const slugs = categoryProducts.map(p => p.slug)
        if (slugs.length > 0) {
          reorderPromises.push(
            api.reorderProducts(category, slugs)
          )
        }
      })

      await Promise.all(reorderPromises)
      
      // обновляем локальное состояние products с новым порядком из reorderedProductsByCategory
      // чтобы избежать визуального "прыжка" при перезагрузке
      setProducts(prevProducts => {
        const productMap = new Map(prevProducts.map(p => [p.slug, p]))
        const updatedProducts: Product[] = []
        
        // собираем товары в новом порядке из reorderedProductsByCategory
        Object.entries(reorderedProductsByCategory).forEach(([, categoryProducts]) => {
          categoryProducts.forEach(reorderedProduct => {
            const existingProduct = productMap.get(reorderedProduct.slug)
            if (existingProduct) {
              updatedProducts.push(existingProduct)
            }
          })
        })
        
        // добавляем товары, которых нет в reorderedProductsByCategory (другие категории)
        prevProducts.forEach(product => {
          if (!updatedProducts.find(p => p.slug === product.slug)) {
            updatedProducts.push(product)
          }
        })
        
        return updatedProducts
      })
      
      showToast('Порядок товаров сохранен', 'success')
      setIsReorderProductsMode(false)
      
      // загружаем товары в фоне для синхронизации с сервером, но не ждем результата
      // чтобы не было визуального "прыжка"
      loadProducts().catch(() => {
        // игнорируем ошибки фоновой загрузки
      })
      
      // очищаем reorderedProductsByCategory после небольшой задержки, чтобы дать время загрузиться
      setTimeout(() => {
        setReorderedProductsByCategory({})
      }, 500)
    } catch (err: any) {
      showToast(err.message || 'Ошибка сохранения порядка товаров', 'error')
    } finally {
      setIsSavingProductsOrder(false)
    }
  }

  const handleDragEndProducts = (event: DragEndEvent, category: string) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setReorderedProductsByCategory(prev => {
        const categoryProducts = prev[category] || []
        const oldIndex = categoryProducts.findIndex((_, idx) => `product-${category}-${idx}` === active.id)
        const newIndex = categoryProducts.findIndex((_, idx) => `product-${category}-${idx}` === over.id)
        
        if (oldIndex !== -1 && newIndex !== -1) {
          const newCategoryProducts = arrayMove(categoryProducts, oldIndex, newIndex)
          return { ...prev, [category]: newCategoryProducts }
        }
        return prev
      })
    }
  }

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
        <div className="header-nav">
          <button 
            className="nav-btn active"
            onClick={() => onNavigate?.('products')}
          >
            Товары
          </button>
          <button 
            className="nav-btn"
            onClick={() => onNavigate?.('promocodes')}
          >
            Промокоды
          </button>
          <button 
            className="nav-btn"
            onClick={() => onNavigate?.('categories')}
          >
            Категории
          </button>
        </div>
        <button onClick={handleLogout} className="logout-btn">
          Выйти
        </button>
      </header>

      <div className="admin-content">
        <div className="toolbar">
          <div className="toolbar-filters">
            <label>
              Категория:
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
              >
                <option value="all">Все категории</option>
                {categoriesForFilter.map((cat) => {
                  const catOption = categories.find((c) => c.key === cat)
                  return (
                    <option key={cat} value={cat}>
                      {catOption ? catOption.title : cat}
                    </option>
                  )
                })}
              </select>
            </label>
            <label className="search-label">
              Поиск по артикулу:
              <div className="search-input-wrapper">
                <input
                  type="text"
                  value={searchArticle}
                  onChange={(e) => setSearchArticle(e.target.value)}
                  placeholder="Введите артикул"
                  className="search-input"
                />
                {searchArticle && (
                  <button
                    type="button"
                    onClick={() => setSearchArticle('')}
                    className="search-clear"
                    title="Очистить поиск"
                  >
                    ×
                  </button>
                )}
              </div>
            </label>
            <button onClick={loadProducts} disabled={loading || isActivating || isDeactivating || isSavingProductsOrder} className="btn-refresh" title="Обновить">
              <span className={`refresh-icon ${(loading || isActivating || isDeactivating || isSavingProductsOrder) ? 'spinning' : ''}`}>↻</span>
            </button>
            {selectedProductSlugs.size > 0 && (() => {
              // определяем, активны ли выбранные товары
              const selectedProducts = products.filter(p => selectedProductSlugs.has(p.slug))
              const allActive = selectedProducts.every(p => p.active)
              const allInactive = selectedProducts.every(p => !p.active)
              
              // если все активны - показываем кнопку отключить
              // если все неактивны - показываем кнопку включить
              // если смешанные - показываем обе кнопки
              return (
                <>
                  {allActive && (
                    <button 
                      onClick={handleDeactivateSelected} 
                      disabled={isDeactivating || isActivating || loading}
                      className="btn-deactivate" 
                      title="Отключить выбранные"
                    >
                      {isDeactivating ? 'Отключение...' : `Отключить (${selectedProductSlugs.size})`}
                    </button>
                  )}
                  {allInactive && (
                    <button 
                      onClick={handleActivateSelected} 
                      disabled={isActivating || isDeactivating || loading}
                      className="btn-activate" 
                      title="Включить выбранные"
                    >
                      {isActivating ? 'Включение...' : `Включить (${selectedProductSlugs.size})`}
                    </button>
                  )}
                  {!allActive && !allInactive && (
                    <>
                      <button 
                        onClick={handleActivateSelected} 
                        disabled={isActivating || isDeactivating || loading}
                        className="btn-activate" 
                        title="Включить выбранные"
                      >
                        {isActivating ? 'Включение...' : `Включить (${selectedProductSlugs.size})`}
                      </button>
                      <button 
                        onClick={handleDeactivateSelected} 
                        disabled={isDeactivating || isActivating || loading}
                        className="btn-deactivate" 
                        title="Отключить выбранные"
                      >
                        {isDeactivating ? 'Отключение...' : `Отключить (${selectedProductSlugs.size})`}
                      </button>
                    </>
                  )}
                </>
              )
            })()}
          </div>
          <div className="toolbar-actions">
            {!isReorderProductsMode ? (
              <>
                <button onClick={handleToggleOrdersStatus} className="btn-orders-status">
                  {ordersClosed ? 'Открыть заказы' : 'Закрыть заказы'}
                </button>
                <button onClick={handleStartReorderProducts} className="btn-reorder-products">
                  Порядок товаров
                </button>
                <button
                  onClick={() => {
                    loadCategories() // обновляем список категорий (могли добавить новую)
                    setIsAddModalOpen(true)
                  }}
                  className="btn-add"
                >
                  Добавить товар
                </button>
              </>
            ) : (
              <>
                <button 
                  onClick={handleSaveProductsOrder}
                  disabled={isSavingProductsOrder}
                  className="btn-save"
                >
                  {isSavingProductsOrder ? 'Сохранение...' : 'Сохранить'}
                </button>
                <button 
                  onClick={handleCancelReorderProducts}
                  disabled={isSavingProductsOrder}
                  className="btn-cancel"
                >
                  Отмена
                </button>
              </>
            )}
          </div>
        </div>

        {error && <div className="error-message">{error}</div>}

        {loading && products.length === 0 ? (
          <div className="loading">Загрузка товаров...</div>
        ) : (
          <div className="products-list">
            {Object.entries(isReorderProductsMode ? reorderedProductsByCategory : groupedProducts).map(([category, categoryProducts]) => (
              <div key={category} className="category-section">
                <h2>{category.charAt(0).toUpperCase() + category.slice(1)}</h2>
                {isReorderProductsMode ? (
                  <DndContext
                    sensors={productsSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(e) => handleDragEndProducts(e, category)}
                  >
                    <SortableContext
                      items={categoryProducts.map((_, idx) => `product-${category}-${idx}`)}
                      strategy={rectSortingStrategy}
                    >
                      <div className="products-grid reorder-mode">
                        {categoryProducts.map((product, index) => (
                          <SortableProductCard
                            key={`reorder-${product.slug}`}
                            id={`product-${category}-${index}`}
                            product={product}
                            selectedProductSlugs={selectedProductSlugs}
                            onToggleSelection={handleToggleProductSelection}
                            onSelect={() => !isReorderProductsMode && setSelectedProduct(product)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <div className="products-grid">
                    {categoryProducts.map(product => (
                      <div
                        key={product.slug}
                        className={`product-card ${!product.active ? 'inactive' : ''} ${selectedProductSlugs.has(product.slug) ? 'selected' : ''}`}
                      >
                        <div className="product-card-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedProductSlugs.has(product.slug)}
                            onChange={(e) => {
                              e.stopPropagation()
                              handleToggleProductSelection(product.slug)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                        <div 
                          className="product-card-content"
                          onClick={() => setSelectedProduct(product)}
                        >
                        <div className="product-images">
                          {product.images.length > 0 ? (
                            <>
                              <img src={product.images[0]} alt={product.title} />
                              {product.badge_text && (
                                <div className="product-card-badge">
                                  {product.badge_text}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="no-image">Нет фото</div>
                          )}
                        </div>
                        <div className="product-info">
                          <h3>{product.title}</h3>
                          <div className="product-meta">
                            {product.article && <span>Артикул: {product.article}</span>}
                            <span>
                              Цена: {product.discount_price_rub !== undefined && product.discount_price_rub > 0 ? (
                                <>
                                  <span style={{ textDecoration: 'line-through', opacity: 0.6, marginRight: '8px' }}>
                                    {product.price_rub} ₽
                                  </span>
                                  <span style={{ color: '#bf9243', fontWeight: 600 }}>
                                    {product.discount_price_rub} ₽
                                  </span>
                                </>
                              ) : (
                                `${product.price_rub} ₽`
                              )}
                            </span>
                            <span className={product.active ? 'active' : 'inactive'}>
                              {product.active ? 'Активен' : 'Неактивен'}
                            </span>
                          </div>
                           {product.description && (
                             <p className="product-description">{product.description}</p>
                           )}
                         </div>
                         </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
         )}

        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onClose={() => setToast(null)}
          />
        )}

        {deleteConfirm && (
          <ConfirmModal
            product={deleteConfirm.product}
            categories={categories}
            onConfirm={(category) => handleDeleteConfirm(category)}
            onCancel={() => setDeleteConfirm(null)}
          />
        )}

        {!loading && filteredProducts.length === 0 && (
          <div className="empty-state">Товары не найдены</div>
        )}
      </div>

      {showScrollTop && (
        <button 
          className="scroll-to-top" 
          onClick={scrollToTop}
          title="Наверх"
          aria-label="Прокрутить вверх"
        >
          ↑
        </button>
      )}

      {selectedProduct && !isEditModalOpen && (
        <ProductModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onEdit={() => {
            loadCategories()
            setIsEditModalOpen(true)
          }}
          onDelete={() => handleDeleteClick(selectedProduct)}
          onProductUpdate={async () => {
            const updatedProducts = await loadProducts()
            // обновляем selectedProduct после перезагрузки
            const updated = updatedProducts.find(p => p.slug === selectedProduct.slug)
            if (updated) {
              setSelectedProduct(updated)
            }
          }}
        />
      )}

      {isEditModalOpen && selectedProduct && (
        <ProductFormModal
          product={selectedProduct}
          products={products}
          categories={categories}
          onClose={() => {
            setIsEditModalOpen(false)
          }}
          onSave={async (updatedProduct) => {
            try {
              await api.updateProduct(selectedProduct.slug, updatedProduct)
              showToast('Товар успешно обновлен', 'success')
              setIsEditModalOpen(false)
              setSelectedProduct(null)
              await loadProducts()
            } catch (err: any) {
              const errorMsg = err.message || 'Ошибка сохранения товара'
              setError(errorMsg)
              showToast(errorMsg, 'error')
              throw err // пробрасываем ошибку в форму
            }
          }}
          showToast={showToast}
        />
      )}

      {isAddModalOpen && (
        <ProductFormModal
          products={products}
          categories={categories}
          onClose={() => setIsAddModalOpen(false)}
          onSave={async (newProduct) => {
            try {
              await api.createProduct(newProduct)
              showToast('Товар успешно добавлен', 'success')
              setIsAddModalOpen(false)
              await loadProducts()
            } catch (err: any) {
              const errorMsg = err.message || 'Ошибка добавления товара'
              setError(errorMsg)
              showToast(errorMsg, 'error')
              throw err // пробрасываем ошибку в форму
            }
          }}
          showToast={showToast}
        />
      )}

      {isOrdersSettingsModalOpen && (
        <OrdersSettingsModal
          ordersClosed={ordersClosed}
          closeDate={ordersCloseDate}
          onClose={() => setIsOrdersSettingsModalOpen(false)}
          onSave={ordersClosed ? handleOpenOrders : handleSaveOrdersSettings}
          isSaving={isSavingOrdersSettings}
          onCloseDateChange={setOrdersCloseDate}
        />
      )}
    </div>
  )
}

// модальное окно для управления статусом заказов
function OrdersSettingsModal({
  ordersClosed,
  closeDate,
  onClose,
  onSave,
  isSaving,
  onCloseDateChange
}: {
  ordersClosed: boolean
  closeDate: string
  onClose: () => void
  onSave: () => void
  isSaving: boolean
  onCloseDateChange: (date: string) => void
}) {
  // если заказы закрыты - показываем простое подтверждающее окно для открытия
  if (ordersClosed) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          <button className="modal-close" onClick={onClose}>&times;</button>
          <h2>Открыть заказы</h2>
          <p style={{ marginBottom: '1.5rem' }}>Вы уверены, что хотите открыть заказы?</p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={onSave} disabled={isSaving}>
              {isSaving ? 'Открытие...' : 'Да, открыть заказы'}
            </button>
            <button className="btn btn-secondary" onClick={onClose} disabled={isSaving}>
              Отмена
            </button>
          </div>
        </div>
      </div>
    )
  }

  // если заказы открыты - показываем модальное окно с полем для даты закрытия
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Закрыть заказы</h2>
        <div className="form-group">
          <label htmlFor="close-date">Дата закрытия (для информационного сообщения):</label>
          <input
            type="date"
            id="close-date"
            value={closeDate}
            onChange={(e) => onCloseDateChange(e.target.value)}
            className="form-input"
            min={new Date().toISOString().split('T')[0]}
          />
          <p className="form-hint">Дата нужна только для информационного сообщения пользователям. Открытие/закрытие происходит вручную.</p>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onSave} disabled={isSaving}>
            {isSaving ? 'Сохранение...' : 'Закрыть заказы'}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={isSaving}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

function ProductModal({
  product,
  onClose,
  onEdit,
  onDelete,
  onProductUpdate
}: {
  product: Product
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onProductUpdate?: () => Promise<void>
}) {
  const [fullscreenImageIndex, setFullscreenImageIndex] = useState<number | null>(null)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [reorderedImages, setReorderedImages] = useState<string[]>(product.images)
  const [isSaving, setIsSaving] = useState(false)

  // настройка сенсоров для drag-and-drop с мгновенной активацией
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 0, // мгновенная активация без задержки
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // синхронизируем reorderedImages при изменении product.images
  useEffect(() => {
    setReorderedImages(product.images)
  }, [product.images])

  const openFullscreen = (index: number) => {
    if (!isReorderMode) {
      setFullscreenImageIndex(index)
    }
  }

  // обработчик для различения скролла и клика на изображении
  const handleImageTouch = (e: React.TouchEvent, index: number) => {
    const touch = e.touches[0]
    const startY = touch.clientY
    const startTime = Date.now()
    
    const handleTouchEnd = (endEvent: TouchEvent) => {
      const endTouch = endEvent.changedTouches[0]
      const endY = endTouch.clientY
      const endTime = Date.now()
      const deltaY = Math.abs(endY - startY)
      const deltaTime = endTime - startTime
      
      // если движение небольшое и быстрое - это клик, иначе скролл
      if (deltaY < 10 && deltaTime < 300) {
        e.preventDefault()
        openFullscreen(index)
      }
      
      document.removeEventListener('touchend', handleTouchEnd)
    }
    
    document.addEventListener('touchend', handleTouchEnd, { once: true })
  }

  const handleStartReorder = () => {
    setIsReorderMode(true)
    setReorderedImages([...product.images])
  }

  const handleCancelReorder = () => {
    setIsReorderMode(false)
    setReorderedImages([...product.images])
  }

  const handleSaveReorder = async () => {
    setIsSaving(true)
    try {
      await api.updateProduct(product.slug, { ...product, images: reorderedImages })
      setIsReorderMode(false)
      // обновляем продукт в родительском компоненте
      if (onProductUpdate) {
        await onProductUpdate()
      }
    } catch (err: any) {
      console.error('Ошибка сохранения порядка фото:', err)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setReorderedImages((items) => {
        const oldIndex = items.findIndex((_, idx) => `image-${idx}` === active.id)
        const newIndex = items.findIndex((_, idx) => `image-${idx}` === over.id)
        return arrayMove(items, oldIndex, newIndex)
      })
    }
  }

  const closeFullscreen = () => {
    setFullscreenImageIndex(null)
  }

  const nextImage = () => {
    if (fullscreenImageIndex !== null && product.images.length > 0) {
      setFullscreenImageIndex((fullscreenImageIndex + 1) % product.images.length)
    }
  }

  const prevImage = () => {
    if (fullscreenImageIndex !== null && product.images.length > 0) {
      setFullscreenImageIndex(
        fullscreenImageIndex === 0 ? product.images.length - 1 : fullscreenImageIndex - 1
      )
    }
  }

  // обработка клавиатуры для навигации
  useEffect(() => {
    if (fullscreenImageIndex !== null) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          closeFullscreen()
        } else if (e.key === 'ArrowRight') {
          if (product.images.length > 0) {
            setFullscreenImageIndex((fullscreenImageIndex + 1) % product.images.length)
          }
        } else if (e.key === 'ArrowLeft') {
          if (product.images.length > 0) {
            setFullscreenImageIndex(
              fullscreenImageIndex === 0 ? product.images.length - 1 : fullscreenImageIndex - 1
            )
          }
        }
      }
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [fullscreenImageIndex, product.images.length])

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={onClose}>&times;</button>
          
          <div className="modal-product">
            <div className="modal-product-images">
              {reorderedImages.length > 0 ? (
                isReorderMode ? (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={reorderedImages.map((_, idx) => `image-${idx}`)}
                      strategy={rectSortingStrategy}
                    >
                      <div className={`modal-images-grid reorder-mode`}>
                        {reorderedImages.map((img, idx) => (
                          <SortableImageItem
                            key={`${img}-${idx}`}
                            id={`image-${idx}`}
                            img={img}
                            index={idx}
                            productTitle={product.title}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <div className="modal-images-grid">
                    {reorderedImages.map((img, idx) => {
                      const originalIndex = product.images.indexOf(img)
                      return (
                        <div
                          key={`${img}-${idx}`}
                          className="image-drag-item"
                          onClick={() => openFullscreen(originalIndex >= 0 ? originalIndex : idx)}
                          onTouchStart={(e) => handleImageTouch(e, originalIndex >= 0 ? originalIndex : idx)}
                        >
                          <img
                            src={img}
                            alt={`${product.title} ${idx + 1}`}
                            className="clickable-image"
                          />
                        </div>
                      )
                    })}
                  </div>
                )
              ) : (
                <div className="no-image">Нет фото</div>
              )}
            </div>

          <div className="modal-product-info">
            <h2>{product.title}</h2>
            
            <div className="modal-product-details">
              <div className="detail-row">
                <span className="detail-label">Slug:</span>
                <span className="detail-value">{product.slug}</span>
              </div>
              
              {product.article && (
                <div className="detail-row">
                  <span className="detail-label">Артикул:</span>
                  <span className="detail-value">{product.article}</span>
                </div>
              )}
              
              <div className="detail-row">
                <span className="detail-label">Категория:</span>
                <span className="detail-value">{product.category}</span>
              </div>
              
              <div className="detail-row">
                <span className="detail-label">Цена:</span>
                <span className="detail-value">
                  {product.discount_price_rub !== undefined && product.discount_price_rub > 0 ? (
                    <>
                      <span style={{ textDecoration: 'line-through', opacity: 0.6, marginRight: '8px' }}>
                        {product.price_rub} ₽
                      </span>
                      <span style={{ color: '#bf9243', fontWeight: 600 }}>
                        {product.discount_price_rub} ₽
                      </span>
                    </>
                  ) : (
                    `${product.price_rub} ₽`
                  )}
                </span>
              </div>
              
              {product.badge_text && (
                <div className="detail-row">
                  <span className="detail-label">Бейдж:</span>
                  <span className="detail-value">
                    <span style={{ 
                      background: '#5e6623', 
                      color: 'white', 
                      padding: '2px 12px', /* вертикальный отступ (сверху и снизу) между границей текста и бейджем */
                      borderRadius: '20px', 
                      fontSize: '12px', 
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px'
                    }}>
                      {product.badge_text}
                    </span>
                  </span>
                </div>
              )}
              
              {product.stock !== undefined && (
                <div className="detail-row">
                  <span className="detail-label">Остаток:</span>
                  <span className="detail-value">{product.stock}</span>
                </div>
              )}
              
              <div className="detail-row">
                <span className="detail-label">Статус:</span>
                <span className={`detail-value ${product.active ? 'active' : 'inactive'}`}>
                  {product.active ? 'Активен' : 'Неактивен'}
                </span>
              </div>
              
              {product.description && (
                <div className="detail-row detail-row-full">
                  <span className="detail-label">Описание:</span>
                  <p className="detail-value">{product.description}</p>
                </div>
              )}
            </div>

            <div className="modal-actions">
              {!isReorderMode ? (
                <>
                  <button className="btn btn-edit" onClick={onEdit}>
                    Редактировать
                  </button>
                  {product.images.length > 1 && (
                    <button className="btn btn-reorder" onClick={handleStartReorder}>
                      Порядок
                    </button>
                  )}
                  <button className="btn btn-delete" onClick={onDelete}>
                    Удалить
                  </button>
                </>
              ) : (
                <>
                  <button 
                    className="btn btn-save" 
                    onClick={handleSaveReorder}
                    disabled={isSaving}
                  >
                    {isSaving ? 'Сохранение...' : 'Сохранить'}
                  </button>
                  <button 
                    className="btn btn-cancel" 
                    onClick={handleCancelReorder}
                    disabled={isSaving}
                  >
                    Отмена
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>

    {fullscreenImageIndex !== null && product.images.length > 0 && !isReorderMode && (
      <ImageFullscreen
        images={product.images}
        currentIndex={fullscreenImageIndex}
        onClose={closeFullscreen}
        onNext={nextImage}
        onPrev={prevImage}
        productTitle={product.title}
      />
    )}
    </>
  )
}

// компонент сортируемого элемента фото
function SortableImageItem({
  id,
  img,
  index,
  productTitle
}: {
  id: string
  img: string
  index: number
  productTitle: string
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition, // убираем transition при перетаскивании для мгновенного отклика
    opacity: isDragging ? 0.4 : 1
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`image-drag-item draggable ${isDragging ? 'dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      <img
        src={img}
        alt={`${productTitle} ${index + 1}`}
        draggable={false}
      />
      <div className="drag-handle">⋮⋮</div>
    </div>
  )
}

// компонент сортируемого элемента товара
function SortableProductCard({
  id,
  product,
  selectedProductSlugs,
  onToggleSelection,
  onSelect
}: {
  id: string
  product: Product
  selectedProductSlugs: Set<string>
  onToggleSelection: (slug: string) => void
  onSelect: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    opacity: isDragging ? 0.5 : 1
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`product-card draggable ${isDragging ? 'dragging' : ''} ${!product.active ? 'inactive' : ''} ${selectedProductSlugs.has(product.slug) ? 'selected' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="product-card-checkbox">
        <input
          type="checkbox"
          checked={selectedProductSlugs.has(product.slug)}
          onChange={(e) => {
            e.stopPropagation()
            onToggleSelection(product.slug)
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div 
        className="product-card-content"
        onClick={onSelect}
      >
        <div className="product-images">
          {product.images.length > 0 ? (
            <>
              <img src={product.images[0]} alt={product.title} />
              {product.badge_text && (
                <div className="product-card-badge">
                  {product.badge_text}
                </div>
              )}
            </>
          ) : (
            <div className="no-image">Нет фото</div>
          )}
        </div>
        <div className="product-info">
          <h3>{product.title}</h3>
          <div className="product-meta">
            {product.article && <span>Артикул: {product.article}</span>}
            <span>
              Цена: {product.discount_price_rub !== undefined && product.discount_price_rub > 0 ? (
                <>
                  <span style={{ textDecoration: 'line-through', opacity: 0.6, marginRight: '8px' }}>
                    {product.price_rub} ₽
                  </span>
                  <span style={{ color: '#bf9243', fontWeight: 600 }}>
                    {product.discount_price_rub} ₽
                  </span>
                </>
              ) : (
                `${product.price_rub} ₽`
              )}
            </span>
            <span className={product.active ? 'active' : 'inactive'}>
              {product.active ? 'Активен' : 'Неактивен'}
            </span>
          </div>
          {product.description && (
            <p className="product-description">{product.description}</p>
          )}
        </div>
      </div>
      <div className="drag-handle">⋮⋮</div>
    </div>
  )
}

// компонент сортируемого элемента фото в форме
function SortableFormImageItem({
  id,
  img,
  index,
  onRemove
}: {
  id: string
  img: string
  index: number
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`image-preview-item draggable ${isDragging ? 'dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      <img src={img} alt={`Фото ${index + 1}`} draggable={false} />
      <div className="image-preview-actions">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="image-action-btn image-action-remove"
          title="Удалить"
        >
          ×
        </button>
      </div>
      <div className="drag-handle">⋮⋮</div>
    </div>
  )
}

function ImageFullscreen({
  images,
  currentIndex,
  onClose,
  onNext,
  onPrev,
  productTitle
}: {
  images: string[]
  currentIndex: number
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  productTitle: string
}) {
  return (
    <div className="fullscreen-overlay" onClick={onClose}>
      <button className="fullscreen-close" onClick={onClose}>&times;</button>
      <button className="fullscreen-nav fullscreen-nav-prev" onClick={(e) => { e.stopPropagation(); onPrev(); }}>
        ‹
      </button>
      <button className="fullscreen-nav fullscreen-nav-next" onClick={(e) => { e.stopPropagation(); onNext(); }}>
        ›
      </button>
      <div className="fullscreen-image-container" onClick={(e) => e.stopPropagation()}>
        <img
          src={images[currentIndex]}
          alt={`${productTitle} ${currentIndex + 1}`}
          className="fullscreen-image"
        />
        <div className="fullscreen-counter">
          {currentIndex + 1} / {images.length}
        </div>
      </div>
    </div>
  )
}

function CategoryMultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  error
}: {
  options: { label: string; value: string }[]
  selected: string[]
  onChange: (values: string[]) => void
  placeholder: string
  error?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value))
    } else {
      onChange([...selected, value])
    }
  }

  const label = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
      : `Выбрано: ${selected.length}`

  return (
    <div className="category-multiselect" ref={ref}>
      <button
        type="button"
        className={`category-multiselect-trigger ${error ? 'has-error' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span>{label}</span>
        <span className="category-multiselect-arrow">{open ? '▲' : '▼'}</span>
      </button>
      {error && <span className="form-error">{error}</span>}
      {open && (
        <div className="category-multiselect-dropdown" role="listbox">
          {options.map((opt) => (
            <label key={opt.value} className="category-multiselect-option">
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function ProductFormModal({
  product,
  products,
  categories,
  onClose,
  onSave,
  showToast
}: {
  product?: Product
  products: Product[]
  categories: CategoryOption[]
  onClose: () => void
  onSave: (product: Partial<Product>) => void | Promise<void>
  showToast: (message: string, type: 'success' | 'error') => void
}) {
  const isEdit = !!product
  
  // получение следующего артикула
  const getNextArticle = (): string => {
    const articles = products
      .map(p => p.article)
      .filter(Boolean)
      .map(article => parseArticle(article || ''))
      .filter((num): num is number => num !== null)
    
    if (articles.length === 0) {
      return formatArticle(1)
    }
    
    const maxArticle = Math.max(...articles)
    return formatArticle(maxArticle + 1)
  }

  const defaultDescription = '• материал...\n• длина...'
  const nextArticle = !isEdit ? getNextArticle() : ''
  
  const [formData, setFormData] = useState<Partial<Product> & { categories?: string[] }>(() => {
    const initialArticle = product?.article || nextArticle
    const initialTitle = product?.title || ''
    const initialSlug = product?.slug || (initialTitle && initialArticle ? generateSlug(initialTitle, initialArticle) : '')
    const initialCategories = product?.categories ?? (product?.category ? [product.category] : [])
    return {
      title: initialTitle,
      slug: initialSlug,
      description: product?.description || (isEdit ? '' : defaultDescription),
      category: product?.category || '',
      categories: initialCategories,
      price_rub: product?.price_rub || 0,
      discount_price_rub: product?.discount_price_rub || undefined,
      badge_text: product?.badge_text || undefined,
      active: product?.active !== undefined ? product.active : true,
      stock: product?.stock || undefined,
      article: initialArticle,
      images: product?.images || []
    }
  })

  // обновляем slug при изменении названия или артикула (только при добавлении)
  useEffect(() => {
    if (!isEdit && formData.title && formData.article) {
      const newSlug = generateSlug(formData.title, formData.article)
      setFormData(prev => {
        if (prev.slug !== newSlug) {
          return { ...prev, slug: newSlug }
        }
        return prev
      })
    }
  }, [formData.title, formData.article, isEdit, formData.slug])

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [uploadingImages, setUploadingImages] = useState<Set<number>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  // настройка сенсоров для drag-and-drop в форме
  const formSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // список категорий: из API (key для value, title для отображения); fallback — из товаров
  const categoryOptions =
    categories.length > 0
      ? categories.map((c) => ({ label: c.title, value: c.key }))
      : Array.from(new Set(products.flatMap((p) => p.categories || [p.category])))
          .filter(Boolean)
          .sort()
          .map((key) => ({ label: key, value: key }))

  // валидация формы
  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.title || formData.title.trim().length === 0) {
      newErrors.title = 'Название обязательно'
    }

    if (!formData.categories?.length) {
      newErrors.categories = 'Выберите хотя бы одну категорию'
    }

    if (!formData.price_rub || formData.price_rub <= 0) {
      newErrors.price_rub = 'Цена должна быть больше 0'
    }

    // валидация цены со скидкой
    if (formData.discount_price_rub !== undefined && formData.discount_price_rub !== null) {
      const discountPrice = typeof formData.discount_price_rub === 'string' 
        ? Number(formData.discount_price_rub) 
        : formData.discount_price_rub
      if (!Number.isFinite(discountPrice) || discountPrice <= 0) {
        newErrors.discount_price_rub = 'Цена со скидкой должна быть больше 0'
      } else if (formData.price_rub && discountPrice >= formData.price_rub) {
        newErrors.discount_price_rub = 'Цена со скидкой должна быть меньше обычной цены'
      }
    }

    // фото необязательное

    // валидация артикула
    if (!isEdit) {
      if (!formData.article || !parseArticle(formData.article)) {
        newErrors.article = 'Артикул должен быть 4-значным числом'
      } else {
        // проверка уникальности
        const exists = products.some(p => p.article === formData.article)
        if (exists) {
          newErrors.article = 'Артикул уже существует'
        }
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!validate()) {
      return
    }

    setSaving(true)
    try {
      // очищаем пробелы в начале и конце badge_text перед сохранением
      const cleanedData = {
        ...formData,
        badge_text: formData.badge_text?.trim() || undefined
      }
      await onSave(cleanedData)
    } catch (err: any) {
      setErrors({ submit: err.message || 'Ошибка сохранения' })
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (field: keyof Product, value: any) => {
    setFormData(prev => {
      const updated = { ...prev, [field]: value }
      
      // автогенерация slug при изменении названия или артикула
      if (field === 'title' || field === 'article') {
        if (updated.title && updated.article) {
          updated.slug = generateSlug(updated.title, updated.article)
        }
      }
      
      return updated
    })
    
    // очищаем ошибку для этого поля
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors[field]
        return newErrors
      })
    }
  }

  const handleImagesChange = (value: string) => {
    // разделяем по новой строке
    const images = value.split('\n').map(img => img.trim()).filter(Boolean)
    handleChange('images', images)
  }

  const handleFileUpload = async (file: File) => {
    // используем уникальный ID для каждой загрузки (timestamp + случайное число)
    const uploadId = Date.now() + Math.random()
    setUploadingImages(prev => new Set(prev).add(uploadId))

    try {
      const url = await api.uploadImage(file)
      // добавляем URL к текущему списку изображений используя функциональное обновление
      setFormData(prev => {
        const currentImages = prev.images || []
        return { ...prev, images: [...currentImages, url] }
      })
    } catch (err: any) {
      showToast(err.message || 'Ошибка загрузки фото', 'error')
    } finally {
      setUploadingImages(prev => {
        const newSet = new Set(prev)
        newSet.delete(uploadId)
        return newSet
      })
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    Array.from(files).forEach(file => {
      // поддерживаем jpeg, jpg, png, webp
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
      if (allowedTypes.includes(file.type.toLowerCase())) {
        handleFileUpload(file)
      } else if (!file.type.startsWith('image/')) {
        showToast('Поддерживаются только изображения: JPG, PNG, WebP', 'error')
      }
    })

    // сбрасываем input для возможности повторной загрузки того же файла
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleRemoveImage = (index: number) => {
    const currentImages = formData.images || []
    const newImages = currentImages.filter((_, i) => i !== index)
    handleChange('images', newImages)
  }

  const handleDragEndForm = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setFormData(prev => {
        const items = prev.images || []
        const oldIndex = items.findIndex((_, idx) => `form-image-${idx}` === active.id)
        const newIndex = items.findIndex((_, idx) => `form-image-${idx}` === over.id)
        if (oldIndex !== -1 && newIndex !== -1) {
          return { ...prev, images: arrayMove(items, oldIndex, newIndex) }
        }
        return prev
      })
    }
  }

  const handlePriceChange = (value: string) => {
    // убираем пробелы и нечисловые символы (кроме точки и запятой)
    const cleaned = value.replace(/\s/g, '').replace(/[^\d.,]/g, '')
    const num = parseFloat(cleaned.replace(',', '.')) || 0
    handleChange('price_rub', num)
  }

  const handleDiscountPriceChange = (value: string) => {
    // убираем пробелы и нечисловые символы (кроме точки и запятой)
    const cleaned = value.replace(/\s/g, '').replace(/[^\d.,]/g, '')
    if (cleaned === '') {
      handleChange('discount_price_rub', undefined)
    } else {
      const num = parseFloat(cleaned.replace(',', '.')) || 0
      handleChange('discount_price_rub', num > 0 ? num : undefined)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-form" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        
        <h2>{isEdit ? 'Редактировать товар' : 'Добавить товар'}</h2>
        
        <form onSubmit={handleSubmit} className="product-form">
          <div className="form-row">
            <div className="form-group">
              <label>Статус</label>
              <select
                value={formData.active ? 'true' : 'false'}
                onChange={(e) => handleChange('active', e.target.value === 'true')}
              >
                <option value="true">Активен</option>
                <option value="false">Неактивен</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Категории *</label>
              <CategoryMultiSelect
                options={categoryOptions}
                selected={formData.categories || []}
                onChange={(values) => {
                  setFormData(prev => ({ ...prev, categories: values, category: values[0] || '' }))
                  if (errors.categories) setErrors(prev => ({ ...prev, categories: '' }))
                }}
                placeholder="Выберите категории"
                error={errors.categories}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Название *</label>
              <input
                type="text"
                value={formData.title || ''}
                onChange={(e) => handleChange('title', e.target.value)}
                required
                placeholder='Введите название товара'
              />
            </div>
            
            <div className="form-group">
              <label>Цена (₽) *</label>
              <input
                type="text"
                value={formData.price_rub || 0}
                onChange={(e) => handlePriceChange(e.target.value)}
                required
                placeholder="0"
              />
              {errors.price_rub && <small style={{ color: '#dc3545' }}>{errors.price_rub}</small>}
            </div>
            
            <div className="form-group">
              <label>Цена со скидкой (₽)</label>
              <input
                type="text"
                value={formData.discount_price_rub !== undefined ? formData.discount_price_rub : ''}
                onChange={(e) => handleDiscountPriceChange(e.target.value)}
                placeholder="Оставь пустым, если скидки нет"
              />
              {errors.discount_price_rub && <small style={{ color: '#dc3545' }}>{errors.discount_price_rub}</small>}
              {!errors.discount_price_rub && formData.discount_price_rub && (
                <small style={{ color: '#666' }}>Старая цена будет перечеркнута, отобразится новая</small>
              )}
            </div>
            
            <div className="form-group">
              <label>Текст бейджа</label>
              <input
                type="text"
                value={formData.badge_text || ''}
                onChange={(e) => handleChange('badge_text', e.target.value || undefined)}
                placeholder="Оставь пустым, чтобы убрать бейдж"
                maxLength={50}
              />
              {formData.badge_text && (
                <small style={{ color: '#666' }}>Бейдж будет отображаться сверху карточки товара</small>
              )}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Остаток</label>
              <input
                type="number"
                min="0"
                value={formData.stock || ''}
                onChange={(e) => handleChange('stock', e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="Количество товара в наличии"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Slug {isEdit ? '(авто)' : '*'}</label>
              <input
                type="text"
                value={formData.slug || ''}
                readOnly
                placeholder="Генерируется автоматически"
                className="readonly-input"
              />
            </div>
            
            <div className="form-group">
              <label>Артикул {isEdit ? '(авто)' : '*'}</label>
              <input
                type="text"
                value={formData.article || ''}
                onChange={(e) => {
                  const value = e.target.value.replace(/\D/g, '').slice(0, 4)
                  handleChange('article', value)
                }}
                disabled={isEdit}
                required={!isEdit}
                placeholder="0081"
                pattern="\d{4}"
                className="readonly-input"
              />
              {errors.article && <small style={{ color: '#dc3545' }}>{errors.article}</small>}
            </div>
          </div>

          <div className="form-group">
            <label>Описание</label>
            <textarea
              value={formData.description || ''}
              onChange={(e) => handleChange('description', e.target.value)}
              rows={4}
              placeholder="Описание товара"
            />
          </div>

          <div className="form-group">
            <label>Фото</label>
            
            {/* миниатюры существующих фото */}
            {formData.images && formData.images.length > 0 && (
              <DndContext
                sensors={formSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEndForm}
              >
                <SortableContext
                  items={formData.images.map((_, idx) => `form-image-${idx}`)}
                  strategy={rectSortingStrategy}
                >
                  <div className="images-preview">
                    {formData.images.map((img, index) => (
                      <SortableFormImageItem
                        key={`form-${img}-${index}`}
                        id={`form-image-${index}`}
                        img={img}
                        index={index}
                        onRemove={() => handleRemoveImage(index)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* загрузка новых фото */}
            <div className="image-upload-area">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                id="image-upload-input"
              />
              <label htmlFor="image-upload-input" className="image-upload-button">
                {uploadingImages.size > 0 ? 'Загрузка...' : 'Загрузить фото'}
              </label>
              {uploadingImages.size > 0 && (
                <div className="uploading-indicator">
                  Загружается {uploadingImages.size} фото...
                </div>
              )}
            </div>
            <small>Загрузите фото через кнопку выше или вставьте URL вручную</small>
            
            {/* текстовое поле для ручного ввода URL (опционально) */}
            <details style={{ marginTop: '0.5rem', width: '100%' }}>
              <summary style={{ cursor: 'pointer', color: '#666', fontSize: '0.9rem' }}>
                Или вставьте URL вручную
              </summary>
              <textarea
                value={(formData.images || []).join('\n')}
                onChange={(e) => handleImagesChange(e.target.value)}
                rows={3}
                placeholder="https://example.com/photo1.jpg&#10;https://example.com/photo2.jpg"
                style={{ marginTop: '0.5rem', width: '100%', boxSizing: 'border-box' }}
              />
            </details>
          </div>

          {errors.submit && (
            <div style={{ background: '#fee', color: '#c33', padding: '0.75rem', borderRadius: '4px' }}>
              {errors.submit}
            </div>
          )}

          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn btn-cancel" disabled={saving}>
              Отмена
            </button>
            <button type="submit" className="btn btn-save" disabled={saving}>
              {saving ? 'Сохранение...' : (isEdit ? 'Сохранить' : 'Добавить')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)
  const [currentPage, setCurrentPage] = useState<'products' | 'promocodes' | 'categories'>('products')
  const [isPageLoading, setIsPageLoading] = useState(false)

  useEffect(() => {
    // проверяем наличие токена
    const token = getToken()
    if (token) {
      setIsAuthenticated(true)
    }
    setChecking(false)
  }, [])

  const handlePageChange = (page: 'products' | 'promocodes' | 'categories') => {
    if (page !== currentPage) {
      setIsPageLoading(true)
      // небольшая задержка для плавной анимации
      setTimeout(() => {
        setCurrentPage(page)
        setIsPageLoading(false)
      }, 150)
    }
  }

  if (checking) {
    return <div className="loading">Загрузка...</div>
  }

  if (!isAuthenticated) {
    return <LoginForm onLogin={() => setIsAuthenticated(true)} />
  }

  return (
    <div className="admin-wrapper">
      {isPageLoading && (
        <div className="page-loading-overlay">
          <div className="page-loading-spinner"></div>
        </div>
      )}
      <div className={`admin-content-wrapper ${isPageLoading ? 'fade-out' : 'fade-in'}`}>
        {currentPage === 'promocodes' ? (
          <PromocodesPage onNavigate={handlePageChange} />
        ) : currentPage === 'categories' ? (
          <CategoriesPage onNavigate={handlePageChange} />
        ) : (
          <ProductsList onNavigate={handlePageChange} />
        )}
      </div>
    </div>
  )
}

