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
        <div className="filters">
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
          <button onClick={loadProducts} disabled={loading}>
            {loading ? 'Загрузка...' : 'Обновить'}
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}

        {loading && products.length === 0 ? (
          <div className="loading">Загрузка товаров...</div>
        ) : (
          <div className="products-list">
            {Object.entries(groupedProducts).map(([category, categoryProducts]) => (
              <div key={category} className="category-section">
                <h2>{category}</h2>
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

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onEdit={() => {
            // TODO: открыть форму редактирования
            console.log('Редактировать:', selectedProduct)
          }}
          onDelete={() => {
            // TODO: подтверждение и удаление
            console.log('Удалить:', selectedProduct)
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

