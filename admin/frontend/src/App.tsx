import { useState, useEffect } from 'react'
import { api, getToken, saveToken, removeToken } from './api'
import { generateSlug, formatArticle, parseArticle } from './utils'
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

// компонент подтверждения удаления
function ConfirmModal({ 
  message, 
  onConfirm, 
  onCancel 
}: { 
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Подтверждение</h3>
        <p>{message}</p>
        <div className="confirm-actions">
          <button onClick={onCancel} className="btn btn-cancel">
            Отмена
          </button>
          <button onClick={onConfirm} className="btn btn-confirm">
            Удалить
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
  category: string
  price_rub: number
  images: string[]
  active: boolean
  stock?: number
  article?: string
  order?: number
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

function ProductsList() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [selectedProductSlugs, setSelectedProductSlugs] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ product: Product } | null>(null)

  useEffect(() => {
    loadProducts()
  }, [])

  const loadProducts = async () => {
    try {
      setLoading(true)
      setError('')
      const data = await api.getProducts()
      setProducts(data.products || [])
      setSelectedProductSlugs(new Set()) // сбрасываем выделение при обновлении
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки товаров')
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

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    
    const product = deleteConfirm.product
    setDeleteConfirm(null)

    try {
      await api.deleteProduct(product.slug)
      showToast('Товар успешно удален', 'success')
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
    }
  }


  const handleLogout = () => {
    removeToken()
    window.location.reload()
  }

  // получаем уникальные категории
  const categories = Array.from(new Set(products.map(p => p.category))).sort()
  
  // фильтруем товары по категории
  const filteredProducts = selectedCategory === 'all'
    ? products
    : products.filter(p => p.category === selectedCategory)

  // группируем по категориям
  const groupedProducts = filteredProducts.reduce((acc, product) => {
    if (!acc[product.category]) {
      acc[product.category] = []
    }
    acc[product.category].push(product)
    return acc
  }, {} as Record<string, Product[]>)

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
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
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </label>
            <button onClick={loadProducts} disabled={loading} className="btn-refresh" title="Обновить">
              <span className={`refresh-icon ${loading ? 'spinning' : ''}`}>↻</span>
            </button>
            {selectedProductSlugs.size > 0 && (
              <button onClick={handleDeactivateSelected} className="btn-deactivate" title="Отключить выбранные">
                Отключить ({selectedProductSlugs.size})
              </button>
            )}
          </div>
          <button onClick={() => setIsAddModalOpen(true)} className="btn-add">
            Добавить товар
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}

        {loading && products.length === 0 ? (
          <div className="loading">Загрузка товаров...</div>
        ) : (
          <div className="products-list">
            {Object.entries(groupedProducts).map(([category, categoryProducts]) => (
              <div key={category} className="category-section">
                <h2>{category.charAt(0).toUpperCase() + category.slice(1)}</h2>
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
                          <img src={product.images[0]} alt={product.title} />
                        ) : (
                          <div className="no-image">Нет фото</div>
                        )}
                      </div>
                      <div className="product-info">
                        <h3>{product.title}</h3>
                        <div className="product-meta">
                          {product.article && <span>Артикул: {product.article}</span>}
                          <span>Цена: {product.price_rub} ₽</span>
                          {product.stock !== undefined && (
                            <span>Остаток: {product.stock}</span>
                          )}
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
            message={`Вы уверены, что хотите удалить товар "${deleteConfirm.product.title}"?`}
            onConfirm={handleDeleteConfirm}
            onCancel={() => setDeleteConfirm(null)}
          />
        )}

        {!loading && filteredProducts.length === 0 && (
          <div className="empty-state">Товары не найдены</div>
        )}
      </div>

      {selectedProduct && !isEditModalOpen && (
        <ProductModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onEdit={() => {
            setIsEditModalOpen(true)
          }}
           onDelete={() => handleDeleteClick(selectedProduct)}
        />
      )}

      {isEditModalOpen && selectedProduct && (
        <ProductFormModal
          product={selectedProduct}
          products={products}
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
        />
      )}

      {isAddModalOpen && (
        <ProductFormModal
          products={products}
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
        />
      )}
    </div>
  )
}

function ProductModal({
  product,
  onClose,
  onEdit,
  onDelete
}: {
  product: Product
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [fullscreenImageIndex, setFullscreenImageIndex] = useState<number | null>(null)

  const openFullscreen = (index: number) => {
    setFullscreenImageIndex(index)
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
              {product.images.length > 0 ? (
                <div className="modal-images-grid">
                  {product.images.map((img, idx) => (
                    <img
                      key={idx}
                      src={img}
                      alt={`${product.title} ${idx + 1}`}
                      onClick={() => openFullscreen(idx)}
                      className="clickable-image"
                    />
                  ))}
                </div>
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
                <span className="detail-value">{product.price_rub} ₽</span>
              </div>
              
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
              
              {product.order !== undefined && (
                <div className="detail-row">
                  <span className="detail-label">Порядок:</span>
                  <span className="detail-value">{product.order}</span>
                </div>
              )}
              
              {product.description && (
                <div className="detail-row">
                  <span className="detail-label">Описание:</span>
                  <p className="detail-value">{product.description}</p>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-edit" onClick={onEdit}>
                Редактировать
              </button>
              <button className="btn btn-delete" onClick={onDelete}>
                Удалить
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    {fullscreenImageIndex !== null && product.images.length > 0 && (
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

function ProductFormModal({
  product,
  products,
  onClose,
  onSave
}: {
  product?: Product
  products: Product[]
  onClose: () => void
  onSave: (product: Partial<Product>) => void | Promise<void>
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
  
  const [formData, setFormData] = useState<Partial<Product>>(() => {
    const initialArticle = product?.article || nextArticle
    const initialTitle = product?.title || ''
    const initialSlug = product?.slug || (initialTitle && initialArticle ? generateSlug(initialTitle, initialArticle) : '')
    
    return {
      title: initialTitle,
      slug: initialSlug,
      description: product?.description || (isEdit ? '' : defaultDescription),
      category: product?.category || '',
      price_rub: product?.price_rub || 0,
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

  // получаем список категорий
  const categories = ['Ягоды', 'Шея', 'Руки', 'Уши', 'Сертификаты']

  // валидация формы
  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.title || formData.title.trim().length === 0) {
      newErrors.title = 'Название обязательно'
    }

    if (!formData.category) {
      newErrors.category = 'Категория обязательна'
    }

    if (!formData.price_rub || formData.price_rub <= 0) {
      newErrors.price_rub = 'Цена должна быть больше 0'
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
      await onSave(formData)
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

  const handlePriceChange = (value: string) => {
    // убираем пробелы и нечисловые символы (кроме точки и запятой)
    const cleaned = value.replace(/\s/g, '').replace(/[^\d.,]/g, '')
    const num = parseFloat(cleaned.replace(',', '.')) || 0
    handleChange('price_rub', num)
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
              <label>Категория *</label>
              <select
                value={formData.category || ''}
                onChange={(e) => handleChange('category', e.target.value)}
                required
              >
                <option value="">Выберите категорию</option>
                {categories.map(cat => (
                  <option key={cat} value={cat.toLowerCase()}>{cat}</option>
                ))}
              </select>
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
            <label>Фото (по одному на строку)</label>
            <textarea
              value={(formData.images || []).join('\n')}
              onChange={(e) => handleImagesChange(e.target.value)}
              rows={6}
              placeholder="https://example.com/photo1.jpg&#10;https://example.com/photo2.jpg"
            />
            <small>Вставьте URL фото, каждое с новой строки</small>
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

  useEffect(() => {
    // проверяем наличие токена
    const token = getToken()
    if (token) {
      setIsAuthenticated(true)
    }
    setChecking(false)
  }, [])

  if (checking) {
    return <div className="loading">Загрузка...</div>
  }

  if (!isAuthenticated) {
    return <LoginForm onLogin={() => setIsAuthenticated(true)} />
  }

  return <ProductsList />
}

