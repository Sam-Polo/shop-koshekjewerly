import { useState, useEffect, useRef } from 'react'
import { api, removeToken } from './api'
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
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { genUuid } from './utils'
import './App.css'

export type AdminPage = 'products' | 'promocodes' | 'categories' | 'bases' | 'pendants'

type Base = {
  id: string
  title: string
  description?: string
  images: string[]
  price: number
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  limit_necklace: number | null
  limit_earrings: number | null
  limit_bracelet: number | null
  article?: string
  badge_text?: string
  active: boolean
  order: number
}

type FormData = {
  id: string
  title: string
  description: string
  images: string[]
  price: string
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  // лимит как строка для поля ввода: '' = по умолчанию (1), '0' = без ограничения
  limit_necklace: string
  limit_earrings: string
  limit_bracelet: string
  article: string
  badge_text: string
  active: boolean
}

const TYPES: { key: 'necklace' | 'earrings' | 'bracelet'; title: string }[] = [
  { key: 'necklace', title: 'Колье' },
  { key: 'earrings', title: 'Серьги' },
  { key: 'bracelet', title: 'Браслет' }
]

const EditIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
)

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
)

function typeBadges(b: Base): string {
  const list: string[] = []
  if (b.for_necklace) list.push('Колье')
  if (b.for_earrings) list.push('Серьги')
  if (b.for_bracelet) list.push('Браслет')
  return list.join(', ') || '—'
}

function SortableBaseRow({
  base,
  dndDisabled = false,
  onEdit,
  onDelete
}: {
  base: Base
  dndDisabled?: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: base.id, disabled: dndDisabled })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <tr ref={setNodeRef} style={style} className={isDragging ? 'dragging' : ''}>
      <td>
        {!dndDisabled && (
          <span className="drag-handle" {...attributes} {...listeners}>⋮⋮</span>
        )}
      </td>
      <td>
        <div
          className="category-row-preview"
          style={{
            backgroundImage: base.images[0] ? `url(${base.images[0]})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
      </td>
      <td>{base.title}</td>
      <td>{base.article || '—'}</td>
      <td>{base.price} ₽</td>
      <td>{typeBadges(base)}</td>
      <td>{base.active ? 'да' : 'нет'}</td>
      <td>
        <button type="button" className="btn-icon btn-edit" onClick={onEdit} title="Редактировать"><EditIcon /></button>
        <button type="button" className="btn-icon btn-delete" onClick={onDelete} title="Удалить"><TrashIcon /></button>
      </td>
    </tr>
  )
}

const emptyForm = (): FormData => ({
  id: '',
  title: '',
  description: '',
  images: [],
  price: '',
  for_necklace: false,
  for_earrings: false,
  for_bracelet: false,
  limit_necklace: '',
  limit_earrings: '',
  limit_bracelet: '',
  article: '',
  badge_text: '',
  active: true
})

function BasesPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [bases, setBases] = useState<Base[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Base | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingBase, setEditingBase] = useState<Base | null>(null)
  const [formData, setFormData] = useState<FormData>(emptyForm())
  const [uploading, setUploading] = useState(false)
  const [articleLoading, setArticleLoading] = useState(false)
  const articleEditedByUserRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'necklace' | 'earrings' | 'bracelet'>('all')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filteredBases = (() => {
    const q = searchQuery.trim().toLowerCase()
    return bases.filter(b => {
      if (typeFilter !== 'all') {
        if (typeFilter === 'necklace' && !b.for_necklace) return false
        if (typeFilter === 'earrings' && !b.for_earrings) return false
        if (typeFilter === 'bracelet' && !b.for_bracelet) return false
      }
      if (!q) return true
      const haystack = [
        b.title,
        b.article || '',
        String(b.price)
      ].join(' ').toLowerCase()
      return haystack.includes(q)
    })
  })()
  const isFiltered = searchQuery.trim() !== '' || typeFilter !== 'all'

  useEffect(() => { load() }, [])

  const showToast = (message: string, type: 'success' | 'error') => setToast({ message, type })

  const load = async () => {
    try {
      setLoading(true)
      const data = await api.getBases()
      setBases((data.bases || []) as Base[])
    } catch (e: any) {
      showToast(e.message || 'Ошибка загрузки основ', 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => { removeToken(); window.location.reload() }

  const handleAdd = async () => {
    setEditingBase(null)
    articleEditedByUserRef.current = false
    setFormData(emptyForm())
    setIsModalOpen(true)
    setArticleLoading(true)
    try {
      const article = await api.getNextArticle()
      // если пользователь успел руками что-то ввести в поле артикула — не перезаписываем
      setFormData(prev => articleEditedByUserRef.current ? prev : { ...prev, article })
    } catch (e: any) {
      console.warn('не удалось получить следующий артикул:', e?.message)
    } finally {
      setArticleLoading(false)
    }
  }

  const handleEdit = (b: Base) => {
    setEditingBase(b)
    setFormData({
      id: b.id,
      title: b.title,
      description: b.description || '',
      images: [...b.images],
      price: String(b.price),
      for_necklace: b.for_necklace,
      for_earrings: b.for_earrings,
      for_bracelet: b.for_bracelet,
      limit_necklace: b.limit_necklace == null ? '' : String(b.limit_necklace),
      limit_earrings: b.limit_earrings == null ? '' : String(b.limit_earrings),
      limit_bracelet: b.limit_bracelet == null ? '' : String(b.limit_bracelet),
      article: b.article || '',
      badge_text: b.badge_text || '',
      active: b.active
    })
    setIsModalOpen(true)
  }

  const handleDeleteClick = (b: Base) => setDeleteConfirm(b)

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const id = deleteConfirm.id
    setDeleteConfirm(null)
    const next = bases.filter(b => b.id !== id).map((b, i) => ({ ...b, order: i }))
    await save(next)
  }

  const save = async (list: Base[]) => {
    try {
      const payload = list.map(b => ({
        id: b.id,
        title: b.title,
        description: b.description,
        images: b.images,
        price: b.price,
        for_necklace: b.for_necklace,
        for_earrings: b.for_earrings,
        for_bracelet: b.for_bracelet,
        limit_necklace: b.for_necklace ? b.limit_necklace : null,
        limit_earrings: b.for_earrings ? b.limit_earrings : null,
        limit_bracelet: b.for_bracelet ? b.limit_bracelet : null,
        article: b.article,
        badge_text: b.badge_text,
        active: b.active
      }))
      await api.saveBases(payload)
      setBases(list)
      showToast('Основы сохранены', 'success')
      load()
    } catch (e: any) {
      showToast(e.message || 'Ошибка сохранения', 'error')
    }
  }

  const parseLimitInput = (raw: string): number | null => {
    const s = raw.trim()
    if (s === '') return null
    const n = parseInt(s, 10)
    if (!Number.isFinite(n) || n < 0) return null
    return n
  }

  const handleSave = async () => {
    const { title, images, price, for_necklace, for_earrings, for_bracelet } = formData
    if (!title.trim()) { showToast('Укажите название', 'error'); return }
    if (images.length === 0) { showToast('Загрузите хотя бы одно фото', 'error'); return }
    const priceNum = Number(price)
    if (!Number.isFinite(priceNum) || priceNum < 0) { showToast('Некорректная цена', 'error'); return }
    if (!for_necklace && !for_earrings && !for_bracelet) {
      showToast('Выберите минимум один тип украшения', 'error'); return
    }

    const updated: Base = {
      id: formData.id || (editingBase?.id ?? genUuid()),
      title: title.trim(),
      description: formData.description.trim() || undefined,
      images: [...images],
      price: priceNum,
      for_necklace,
      for_earrings,
      for_bracelet,
      limit_necklace: for_necklace ? parseLimitInput(formData.limit_necklace) : null,
      limit_earrings: for_earrings ? parseLimitInput(formData.limit_earrings) : null,
      limit_bracelet: for_bracelet ? parseLimitInput(formData.limit_bracelet) : null,
      article: formData.article.trim() || undefined,
      badge_text: formData.badge_text.trim() || undefined,
      active: formData.active,
      order: editingBase?.order ?? bases.length
    }

    let next: Base[]
    if (editingBase) {
      next = bases.map(b => b.id === editingBase.id ? updated : b)
    } else {
      next = [...bases, updated].map((b, i) => ({ ...b, order: i }))
    }
    await save(next)
    setIsModalOpen(false)
  }

  const handleFileUpload = async (file: File) => {
    setUploading(true)
    try {
      const url = await api.uploadImage(file)
      setFormData(prev => ({ ...prev, images: [...prev.images, url] }))
    } catch (e: any) {
      showToast(e.message || 'Ошибка загрузки фото', 'error')
    } finally {
      setUploading(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    Array.from(files).forEach(file => {
      if (allowed.includes(file.type.toLowerCase())) {
        handleFileUpload(file)
      } else {
        showToast('Поддерживаются JPG, PNG, WebP', 'error')
      }
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeImage = (idx: number) => {
    setFormData(prev => ({ ...prev, images: prev.images.filter((_, i) => i !== idx) }))
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = bases.findIndex(b => b.id === active.id)
    const newIndex = bases.findIndex(b => b.id === over.id)
    if (oldIndex !== -1 && newIndex !== -1) {
      const next = arrayMove(bases, oldIndex, newIndex).map((b, i) => ({ ...b, order: i }))
      setBases(next)
      save(next)
    }
  }

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
        <div className="header-nav">
          <button className="nav-btn" onClick={() => onNavigate?.('products')}>Товары</button>
          <button className="nav-btn" onClick={() => onNavigate?.('promocodes')}>Промокоды</button>
          <button className="nav-btn" onClick={() => onNavigate?.('categories')}>Категории</button>
          <button className="nav-btn active" onClick={() => onNavigate?.('bases')}>Конструктор</button>
        </div>
        <div className="header-actions">
          <button className="btn btn-add" onClick={handleAdd}>+ Добавить основу</button>
          <button onClick={handleLogout} className="logout-btn">Выйти</button>
        </div>
      </header>

      <div className="categories-content">
        <div className="constructor-subnav">
          <button
            type="button"
            className="constructor-subnav-tab active"
            onClick={() => onNavigate?.('bases')}
          >
            Основы
          </button>
          <button
            type="button"
            className="constructor-subnav-tab"
            onClick={() => onNavigate?.('pendants')}
          >
            Подвески
          </button>
        </div>

        <p className="categories-hint">
          Основы — компоненты конструктора украшений. У каждой основы задаётся лимит количества подвесок для каждого типа украшения, к которому она привязана. Лимит «0» = без ограничения, пусто = по умолчанию (1 подвеска).
        </p>

        {bases.length > 0 && (
          <div className="constructor-toolbar">
            <input
              type="text"
              placeholder="Поиск: артикул, название, цена…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as any)}
            >
              <option value="all">Все типы</option>
              <option value="necklace">Колье</option>
              <option value="earrings">Серьги</option>
              <option value="bracelet">Браслет</option>
            </select>
          </div>
        )}

        {bases.length === 0 ? (
          <div className="empty-state">
            <p>Нет основ. Добавьте первую.</p>
          </div>
        ) : filteredBases.length === 0 ? (
          <div className="constructor-empty-filter">
            Ничего не найдено по текущему фильтру.
          </div>
        ) : (
          <div className="categories-table-wrapper">
            <table className="categories-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Фото</th>
                  <th>Название</th>
                  <th>Артикул</th>
                  <th>Цена</th>
                  <th>Типы</th>
                  <th>Активна</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={isFiltered ? () => {} : handleDragEnd}
                >
                  <SortableContext
                    items={filteredBases.map(b => b.id)}
                    strategy={verticalListSortingStrategy}
                    disabled={isFiltered}
                  >
                    {filteredBases.map(b => (
                      <SortableBaseRow
                        key={b.id}
                        base={b}
                        dndDisabled={isFiltered}
                        onEdit={() => handleEdit(b)}
                        onDelete={() => handleDeleteClick(b)}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
          <button className="toast-close" onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-content confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>Удалить основу?</h3>
            <p>Основа «{deleteConfirm.title}» будет удалена из таблицы.</p>
            <div className="confirm-actions">
              <button className="btn btn-cancel" onClick={() => setDeleteConfirm(null)}>Отмена</button>
              <button className="btn btn-confirm" onClick={handleDeleteConfirm}>Удалить</button>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal-content modal-form" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsModalOpen(false)}>×</button>
            <h2>{editingBase ? 'Редактировать основу' : 'Добавить основу'}</h2>

            <div className="form-group">
              <label>Название *</label>
              <input
                type="text"
                value={formData.title}
                onChange={e => setFormData(p => ({ ...p, title: e.target.value }))}
                placeholder="Английский замок"
              />
            </div>

            <div className="form-group">
              <label>Описание</label>
              <textarea
                value={formData.description}
                onChange={e => setFormData(p => ({ ...p, description: e.target.value }))}
                placeholder={'Описание основы.\n\nМожно несколько абзацев с пустыми строками.'}
                rows={5}
                style={{ resize: 'vertical', minHeight: 120, fontFamily: 'inherit' }}
              />
            </div>

            <div className="form-group">
              <label>Артикул {articleLoading && <small style={{ color: '#888', fontWeight: 400 }}>· подгружаем следующий…</small>}</label>
              <input
                type="text"
                className={articleLoading && !formData.article ? 'article-loading' : ''}
                value={formData.article}
                onChange={e => {
                  articleEditedByUserRef.current = true
                  setFormData(p => ({ ...p, article: e.target.value }))
                }}
                placeholder={articleLoading ? 'Подгружаем артикул…' : '0001'}
              />
            </div>

            <div className="form-group">
              <label>Бейдж (текст плашки на карточке)</label>
              <input
                type="text"
                value={formData.badge_text}
                onChange={e => setFormData(p => ({ ...p, badge_text: e.target.value }))}
                placeholder="НОВИНКА / ХИТ / СКИДКА"
              />
            </div>

            <div className="form-group">
              <label>Цена (₽) *</label>
              <input
                type="number"
                min="0"
                value={formData.price}
                onChange={e => setFormData(p => ({ ...p, price: e.target.value }))}
                placeholder="1500"
              />
            </div>

            <div className="form-group">
              <label>Фото * (можно несколько, первое будет главным)</label>
              <div className="image-upload-area">
                <input
                  type="file"
                  ref={fileInputRef}
                  id="base-image-input"
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  multiple
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
                <label htmlFor="base-image-input" className="image-upload-button">
                  {uploading ? 'Загрузка...' : 'Загрузить фото'}
                </label>
              </div>
              {formData.images.length > 0 && (
                <div className="constructor-image-thumbs">
                  {formData.images.map((url, i) => (
                    <div key={url + i} style={{ position: 'relative' }}>
                      <div
                        style={{
                          width: 80,
                          height: 80,
                          borderRadius: 6,
                          border: i === 0 ? '2px solid #3942b8' : '1px solid #e8e8e8',
                          backgroundImage: `url(${url})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center'
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        title="Удалить"
                        style={{
                          position: 'absolute', top: -8, right: -8,
                          width: 22, height: 22, borderRadius: '50%',
                          background: '#fff', border: '1px solid #ddd',
                          cursor: 'pointer', fontSize: 12, lineHeight: 1
                        }}
                      >
                        ×
                      </button>
                      {i === 0 && (
                        <div style={{
                          position: 'absolute', bottom: 2, left: 2,
                          fontSize: 10, padding: '2px 4px',
                          background: 'rgba(0,0,0,0.65)', color: '#fff', borderRadius: 3
                        }}>
                          главное
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="form-group">
              <label>Типы украшений *</label>
              <div className="constructor-types-list">
                {TYPES.map(t => {
                  const checkedKey = `for_${t.key}` as 'for_necklace' | 'for_earrings' | 'for_bracelet'
                  const limitKey = `limit_${t.key}` as 'limit_necklace' | 'limit_earrings' | 'limit_bracelet'
                  const checked = formData[checkedKey]
                  return (
                    <div key={t.key} className="constructor-type-row">
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          margin: 0,
                          cursor: 'pointer',
                          fontWeight: 500,
                          color: '#333',
                          userSelect: 'none'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e => setFormData(p => ({ ...p, [checkedKey]: e.target.checked }))}
                          style={{
                            width: 18,
                            height: 18,
                            margin: 0,
                            padding: 0,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                            background: '#fff',
                            cursor: 'pointer',
                            accentColor: '#3942b8',
                            flexShrink: 0,
                            boxShadow: 'none'
                          }}
                        />
                        <span>{t.title}</span>
                      </label>
                      {checked ? (
                        <div className="constructor-type-limit">
                          <span>Макс. подвесок:</span>
                          <input
                            type="number"
                            min="0"
                            value={formData[limitKey]}
                            onChange={e => setFormData(p => ({ ...p, [limitKey]: e.target.value }))}
                            placeholder="1"
                            style={{
                              width: 72,
                              padding: '6px 8px',
                              fontSize: 14,
                              margin: 0,
                              height: 32,
                              boxSizing: 'border-box',
                              boxShadow: 'none'
                            }}
                          />
                          <small style={{ color: '#888', fontSize: 12 }}>0 = без огр.</small>
                        </div>
                      ) : (
                        <span style={{ color: '#bbb', fontSize: 13 }}>—</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="form-group">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                  fontWeight: 500,
                  color: '#333',
                  userSelect: 'none',
                  margin: 0
                }}
              >
                <input
                  type="checkbox"
                  checked={formData.active}
                  onChange={e => setFormData(p => ({ ...p, active: e.target.checked }))}
                  style={{
                    width: 18,
                    height: 18,
                    margin: 0,
                    padding: 0,
                    border: '1px solid #ccc',
                    borderRadius: 3,
                    cursor: 'pointer',
                    accentColor: '#3942b8',
                    flexShrink: 0,
                    boxShadow: 'none'
                  }}
                />
                <span>Активна (видна в мини-приложении)</span>
              </label>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-cancel" onClick={() => setIsModalOpen(false)}>Отмена</button>
              <button type="button" className="btn btn-confirm" onClick={handleSave}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default BasesPage
