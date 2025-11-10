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
    throw new Error(error.error || 'request_failed')
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
  }
}

