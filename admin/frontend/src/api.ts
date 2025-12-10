const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4001'

// сохранение токена в localStorage
export function saveToken(token: string) {
  localStorage.setItem('admin_token', token)
}

// получение токена из localStorage
export function getToken(): string | null {
  return localStorage.getItem('admin_token')
}

// удаление токена
export function removeToken() {
  localStorage.removeItem('admin_token')
}

// базовый fetch с авторизацией
async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = getToken()
  const headers = new Headers(options.headers)
  
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  
  const response = await fetch(`${API_URL}${url}`, {
    ...options,
    headers
  })
  
  if (response.status === 401) {
    removeToken()
    window.location.href = '/'
    throw new Error('unauthorized')
  }
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'unknown_error' }))
    const errorMessage = error.error || 'request_failed'
    
    // переводим коды ошибок в понятные сообщения
    const errorMessages: Record<string, string> = {
      'missing_required_fields': 'Заполните все обязательные поля',
      'invalid_price': 'Некорректная цена',
      'invalid_discount_price': 'Некорректная цена со скидкой',
      'discount_price_must_be_less': 'Цена со скидкой должна быть меньше обычной цены',
      'images_required': 'Добавьте хотя бы одно фото',
      'article_already_exists': 'Артикул уже существует',
      'slug_already_exists': 'Slug уже существует',
      'invalid_category': 'Некорректная категория',
      'product_not_found': 'Товар не найден',
      'failed_to_create_product': 'Ошибка создания товара',
      'failed_to_update_product': 'Ошибка обновления товара',
      'failed_to_delete_product': 'Ошибка удаления товара'
    }
    
    throw new Error(errorMessages[errorMessage] || errorMessage)
  }
  
  return response.json()
}

// API методы
export const api = {
  // авторизация
  async login(username: string, password: string) {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'login_failed' }))
      throw new Error(error.error || 'login_failed')
    }
    
    const data = await response.json()
    return data
  },
  
  // получение списка товаров
  async getProducts() {
    return fetchWithAuth('/api/products')
  },

  // добавление товара
  async createProduct(product: any) {
    return fetchWithAuth('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product)
    })
  },

  // обновление товара
  async updateProduct(slug: string, product: any) {
    return fetchWithAuth(`/api/products/${slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product)
    })
  },

  // удаление товара
  async deleteProduct(slug: string) {
    return fetchWithAuth(`/api/products/${slug}`, {
      method: 'DELETE'
    })
  },

  // переупорядочивание товаров в категории
  async reorderProducts(category: string, slugs: string[]) {
    return fetchWithAuth('/api/products/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, slugs })
    })
  },

  // загрузка фото в Uploadcare
  async uploadImage(file: File): Promise<string> {
    const formData = new FormData()
    formData.append('file', file)

    const token = getToken()
    const response = await fetch(`${API_URL}/api/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    })

    if (response.status === 401) {
      removeToken()
      window.location.href = '/'
      throw new Error('unauthorized')
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'upload_failed' }))
      throw new Error(error.error || 'upload_failed')
    }

    const data = await response.json()
    return data.url
  },

  // промокоды
  async getPromocodes() {
    return fetchWithAuth('/api/promocodes')
  },

  async createPromocode(promocode: any) {
    return fetchWithAuth('/api/promocodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promocode)
    })
  },

  async updatePromocode(code: string, promocode: any) {
    return fetchWithAuth(`/api/promocodes/${code}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promocode)
    })
  },

  async deletePromocode(code: string) {
    return fetchWithAuth(`/api/promocodes/${code}`, {
      method: 'DELETE'
    })
  },

  // настройки заказов
  async getOrdersSettings() {
    return fetchWithAuth('/api/settings/orders-status')
  },

  async updateOrdersSettings(settings: { ordersClosed: boolean; closeDate?: string }) {
    return fetchWithAuth('/api/settings/orders-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
  }
}

