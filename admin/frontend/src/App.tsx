import { useState, useEffect } from 'react'
import { api, getToken, saveToken, removeToken } from './api'
import './App.css'

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

  useEffect(() => {
    loadProducts()
  }, [])

  const loadProducts = async () => {
    try {
      setLoading(true)
      setError('')
      const data = await api.getProducts()
      setProducts(data.products || [])
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки товаров')
    } finally {
      setLoading(false)
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
              <span className="refresh-icon">↻</span>
            </button>
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
                      className={`product-card ${!product.active ? 'inactive' : ''}`}
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
                  ))}
                </div>
              </div>
            ))}
          </div>
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
          onDelete={() => {
            // TODO: подтверждение и удаление
            console.log('Удалить:', selectedProduct)
          }}
        />
      )}

      {isEditModalOpen && selectedProduct && (
        <ProductFormModal
          product={selectedProduct}
          onClose={() => {
            setIsEditModalOpen(false)
          }}
          onSave={(updatedProduct) => {
            // TODO: сохранить изменения
            console.log('Сохранить:', updatedProduct)
            setIsEditModalOpen(false)
            setSelectedProduct(null)
            loadProducts()
          }}
        />
      )}

      {isAddModalOpen && (
        <ProductFormModal
          onClose={() => setIsAddModalOpen(false)}
          onSave={(newProduct) => {
            // TODO: добавить товар
            console.log('Добавить:', newProduct)
            setIsAddModalOpen(false)
            loadProducts()
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
  onClose,
  onSave
}: {
  product?: Product
  onClose: () => void
  onSave: (product: Partial<Product>) => void
}) {
  const isEdit = !!product
  const defaultDescription = '• материал...\n• длина...'
  const [formData, setFormData] = useState<Partial<Product>>({
    title: product?.title || '',
    slug: product?.slug || '',
    description: product?.description || (isEdit ? '' : defaultDescription),
    category: product?.category || '',
    price_rub: product?.price_rub || 0,
    active: product?.active !== undefined ? product.active : true,
    stock: product?.stock || undefined,
    article: product?.article || '',
    images: product?.images || [],
    order: product?.order || undefined
  })

  // получаем список категорий
  const categories = ['Ягоды', 'Шея', 'Руки', 'Уши', 'Сертификаты']

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(formData)
  }

  const handleChange = (field: keyof Product, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleImagesChange = (value: string) => {
    // разделяем по новой строке
    const images = value.split('\n').map(img => img.trim()).filter(Boolean)
    handleChange('images', images)
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
              <label>Slug *</label>
              <input
                type="text"
                value={formData.slug || ''}
                onChange={(e) => handleChange('slug', e.target.value)}
                required
                placeholder="kolie-s-malinkoy-123456"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Цена (₽) *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={formData.price_rub || 0}
                onChange={(e) => handleChange('price_rub', parseFloat(e.target.value) || 0)}
                required
              />
            </div>
            
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
              <label>Порядок</label>
              <input
                type="number"
                min="0"
                value={formData.order || ''}
                onChange={(e) => handleChange('order', e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="TODO..."
              />
            </div>
            
            <div className="form-group">
              <label>Артикул</label>
              <input
                type="text"
                value={formData.article || ''}
                onChange={(e) => handleChange('article', e.target.value)}
                placeholder="0081"
              />
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
            <label>Фото (по одному на строку) *</label>
            <textarea
              value={(formData.images || []).join('\n')}
              onChange={(e) => handleImagesChange(e.target.value)}
              rows={6}
              placeholder="https://example.com/photo1.jpg&#10;https://example.com/photo2.jpg"
              required
            />
            <small>Вставьте URL фото, каждое с новой строки</small>
          </div>

          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn btn-cancel">
              Отмена
            </button>
            <button type="submit" className="btn btn-save">
              {isEdit ? 'Сохранить' : 'Добавить'}
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

