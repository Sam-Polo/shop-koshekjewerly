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
    let errorMessage = 'request_failed'
    try {
      const error = await response.json()
      const base = error.error || error.message || 'request_failed'
      errorMessage = error.detail ? `${base}: ${error.detail}` : base
    } catch {
      // если не удалось распарсить JSON, пробуем получить текст
      try {
        const text = await response.text()
        errorMessage = text || `Ошибка ${response.status}: ${response.statusText}`
      } catch {
        errorMessage = `Ошибка ${response.status}: ${response.statusText}`
      }
    }
    
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
      'product_not_in_category': 'Товар не найден в указанной категории',
      'file_too_large': 'Файл слишком большой (максимум 10 МБ)',
      'failed_to_create_product': 'Ошибка создания товара',
      'failed_to_update_product': 'Ошибка обновления товара',
      'failed_to_delete_product': 'Ошибка удаления товара',
      'GOOGLE_SHEET_ID not configured': 'GOOGLE_SHEET_ID не настроен',
      'ordersClosed must be a boolean': 'ordersClosed должен быть boolean',
      'closeDate must be in format YYYY-MM-DD': 'Дата должна быть в формате YYYY-MM-DD'
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

  // удаление товара (category — только из этой категории; без — из всех)
  async deleteProduct(slug: string, category?: string) {
    const url = category
      ? `/api/products/${encodeURIComponent(slug)}?category=${encodeURIComponent(category)}`
      : `/api/products/${slug}`
    return fetchWithAuth(url, {
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

  // загрузка фото/видео в S3 (таймаут 2 мин для фото; для видео больше —
  // конвертация на сервере дольше, см. docs/VIDEO_SUPPORT.md)
  async uploadImage(file: File, timeoutMs: number = 120000): Promise<string> {
    const formData = new FormData()
    formData.append('file', file)

    const token = getToken()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(`${API_URL}/api/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData,
      signal: controller.signal
    })
    clearTimeout(timeoutId)

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

  async updateOrdersSettings(settings: { ordersClosed: boolean; closeDate?: string; assemblyMessage?: string; trackMessage?: string; shippedMessage?: string; assembledMessage?: string; priorityOrderEnabled?: boolean; priorityOrderFee?: number }) {
    return fetchWithAuth('/api/settings/orders-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
  },

  // настройки баннера
  async getBannerSettings() {
    return fetchWithAuth('/api/settings/banner')
  },

  async updateBannerSettings(banner: {
    bannerEnabled: boolean
    bannerText: string
    bannerStyle: 'pink' | 'gold' | 'neutral'
    bannerDateFrom?: string
    bannerDateTo?: string
  }) {
    return fetchWithAuth('/api/settings/banner', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(banner)
    })
  },

  // категории
  async getCategories() {
    return fetchWithAuth('/api/categories')
  },

  async saveCategories(categories: Array<{ key: string; title: string; description?: string; image: string; image_position?: string; active?: boolean }>) {
    return fetchWithAuth('/api/categories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories })
    })
  },

  // конструктор: основы
  async getBases() {
    return fetchWithAuth('/api/bases')
  },

  async saveBases(bases: Array<any>) {
    return fetchWithAuth('/api/bases', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bases })
    })
  },

  // конструктор: подвески
  async getPendants() {
    return fetchWithAuth('/api/pendants')
  },

  async savePendants(pendants: Array<any>) {
    return fetchWithAuth('/api/pendants', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendants })
    })
  },

  // следующий доступный артикул (max+1 среди товаров, основ и подвесок)
  async getNextArticle(): Promise<string> {
    const data = await fetchWithAuth('/api/articles/next')
    return data.next
  },

  // ── статистика, заказы, клиенты ──────────────────────────────────────────
  async getOrders(params: { from?: string; to?: string; platform?: string; category?: string; status?: string; search?: string; hasNote?: string } = {}) {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v) })
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return fetchWithAuth(`/api/orders${suffix}`)
  },

  async updateOrderNote(orderId: string, note: string) {
    return fetchWithAuth(`/api/orders/${encodeURIComponent(orderId)}/note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    })
  },

  async notifyShipped(orderId: string): Promise<{ ok: boolean; alreadyNotified?: boolean }> {
    return fetchWithAuth(`/api/orders/${encodeURIComponent(orderId)}/notify-shipped`, {
      method: 'POST'
    })
  },

  async getCustomers(search?: string) {
    const suffix = search ? `?search=${encodeURIComponent(search)}` : ''
    return fetchWithAuth(`/api/customers${suffix}`)
  },

  async getCustomerOrders(id: string) {
    return fetchWithAuth(`/api/customers/${encodeURIComponent(id)}/orders`)
  },

  async getStats(params: { from?: string; to?: string; platform?: string; category?: string } = {}) {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v) })
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return fetchWithAuth(`/api/stats${suffix}`)
  },

  async getStatsCategories() {
    return fetchWithAuth('/api/stats/categories')
  },

  async getShipments(params: { from?: string; to?: string; source?: string; status?: string; nocache?: boolean } = {}) {
    const qs = new URLSearchParams()
    const { nocache, ...rest } = params
    Object.entries(rest).forEach(([k, v]) => { if (v) qs.set(k, v as string) })
    if (nocache) qs.set('nocache', '1')
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return fetchWithAuth(`/api/shipments${suffix}`)
  }
}

