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
import type { AdminPage } from './BasesPage'
import { genUuid } from './utils'
import './App.css'

type Pendant = {
  id: string
  title: string
  description?: string
  image: string
  price: number
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
  active: boolean
  order: number
}

type FormData = {
  id: string
  title: string
  description: string
  image: string
  price: string
  for_necklace: boolean
  for_earrings: boolean
  for_bracelet: boolean
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

function typeBadges(p: Pendant): string {
  const list: string[] = []
  if (p.for_necklace) list.push('Колье')
  if (p.for_earrings) list.push('Серьги')
  if (p.for_bracelet) list.push('Браслет')
  return list.join(', ') || '—'
}

function SortablePendantRow({
  pendant,
  onEdit,
  onDelete
}: {
  pendant: Pendant
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pendant.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <tr ref={setNodeRef} style={style} className={isDragging ? 'dragging' : ''}>
      <td><span className="drag-handle" {...attributes} {...listeners}>⋮⋮</span></td>
      <td>
        <div
          className="category-row-preview"
          style={{
            backgroundImage: pendant.image ? `url(${pendant.image})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
      </td>
      <td>{pendant.title}</td>
      <td>{pendant.price} ₽</td>
      <td>{typeBadges(pendant)}</td>
      <td>{pendant.active ? 'да' : 'нет'}</td>
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
  image: '',
  price: '',
  for_necklace: false,
  for_earrings: false,
  for_bracelet: false,
  active: true
})

function PendantsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [pendants, setPendants] = useState<Pendant[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Pendant | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingPendant, setEditingPendant] = useState<Pendant | null>(null)
  const [formData, setFormData] = useState<FormData>(emptyForm())
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { load() }, [])

  const showToast = (message: string, type: 'success' | 'error') => setToast({ message, type })

  const load = async () => {
    try {
      setLoading(true)
      const data = await api.getPendants()
      setPendants((data.pendants || []) as Pendant[])
    } catch (e: any) {
      showToast(e.message || 'Ошибка загрузки подвесок', 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => { removeToken(); window.location.reload() }

  const handleAdd = () => {
    setEditingPendant(null)
    setFormData(emptyForm())
    setIsModalOpen(true)
  }

  const handleEdit = (p: Pendant) => {
    setEditingPendant(p)
    setFormData({
      id: p.id,
      title: p.title,
      description: p.description || '',
      image: p.image,
      price: String(p.price),
      for_necklace: p.for_necklace,
      for_earrings: p.for_earrings,
      for_bracelet: p.for_bracelet,
      active: p.active
    })
    setIsModalOpen(true)
  }

  const handleDeleteClick = (p: Pendant) => setDeleteConfirm(p)

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const id = deleteConfirm.id
    setDeleteConfirm(null)
    const next = pendants.filter(p => p.id !== id).map((p, i) => ({ ...p, order: i }))
    await save(next)
  }

  const save = async (list: Pendant[]) => {
    try {
      await api.savePendants(list)
      setPendants(list)
      showToast('Подвески сохранены', 'success')
      load()
    } catch (e: any) {
      showToast(e.message || 'Ошибка сохранения', 'error')
    }
  }

  const handleSave = async () => {
    const { title, image, price, for_necklace, for_earrings, for_bracelet } = formData
    if (!title.trim()) { showToast('Укажите название', 'error'); return }
    if (!image.trim()) { showToast('Загрузите фото', 'error'); return }
    const priceNum = Number(price)
    if (!Number.isFinite(priceNum) || priceNum < 0) { showToast('Некорректная цена', 'error'); return }
    if (!for_necklace && !for_earrings && !for_bracelet) {
      showToast('Выберите минимум один тип украшения', 'error'); return
    }

    const updated: Pendant = {
      id: formData.id || (editingPendant?.id ?? genUuid()),
      title: title.trim(),
      description: formData.description.trim() || undefined,
      image: image.trim(),
      price: priceNum,
      for_necklace,
      for_earrings,
      for_bracelet,
      active: formData.active,
      order: editingPendant?.order ?? pendants.length
    }

    let next: Pendant[]
    if (editingPendant) {
      next = pendants.map(p => p.id === editingPendant.id ? updated : p)
    } else {
      next = [...pendants, updated].map((p, i) => ({ ...p, order: i }))
    }
    await save(next)
    setIsModalOpen(false)
  }

  const handleFileUpload = async (file: File) => {
    setUploading(true)
    try {
      const url = await api.uploadImage(file)
      setFormData(prev => ({ ...prev, image: url }))
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
    const file = files[0]
    if (allowed.includes(file.type.toLowerCase())) handleFileUpload(file)
    else showToast('Поддерживаются JPG, PNG, WebP', 'error')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = pendants.findIndex(p => p.id === active.id)
    const newIndex = pendants.findIndex(p => p.id === over.id)
    if (oldIndex !== -1 && newIndex !== -1) {
      const next = arrayMove(pendants, oldIndex, newIndex).map((p, i) => ({ ...p, order: i }))
      setPendants(next)
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
          <button className="btn btn-add" onClick={handleAdd}>+ Добавить подвеску</button>
          <button onClick={handleLogout} className="logout-btn">Выйти</button>
        </div>
      </header>

      <div className="categories-content">
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid #e8e8e8', paddingBottom: 0 }}>
          <button
            type="button"
            onClick={() => onNavigate?.('bases')}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              border: 'none',
              borderBottom: '2px solid transparent',
              color: '#666',
              cursor: 'pointer',
              fontSize: 14
            }}
          >
            Основы
          </button>
          <button
            type="button"
            onClick={() => onNavigate?.('pendants')}
            style={{
              padding: '10px 18px',
              background: 'transparent',
              border: 'none',
              borderBottom: '2px solid #3942b8',
              color: '#3942b8',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 14
            }}
          >
            Подвески
          </button>
        </div>

        <p className="categories-hint">
          Подвески — компоненты конструктора украшений. Привязываются к одному или нескольким типам украшений (колье, серьги, браслет). Лимит количества подвесок задаётся на основе.
        </p>
        {pendants.length === 0 ? (
          <div className="empty-state">
            <p>Нет подвесок. Добавьте первую.</p>
          </div>
        ) : (
          <div className="categories-table-wrapper">
            <table className="categories-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Фото</th>
                  <th>Название</th>
                  <th>Цена</th>
                  <th>Типы</th>
                  <th>Активна</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={pendants.map(p => p.id)} strategy={verticalListSortingStrategy}>
                    {pendants.map(p => (
                      <SortablePendantRow key={p.id} pendant={p} onEdit={() => handleEdit(p)} onDelete={() => handleDeleteClick(p)} />
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
            <h3>Удалить подвеску?</h3>
            <p>Подвеска «{deleteConfirm.title}» будет удалена из таблицы.</p>
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
            <h2>{editingPendant ? 'Редактировать подвеску' : 'Добавить подвеску'}</h2>

            <div className="form-group">
              <label>Название *</label>
              <input
                type="text"
                value={formData.title}
                onChange={e => setFormData(p => ({ ...p, title: e.target.value }))}
                placeholder="Луна"
              />
            </div>

            <div className="form-group">
              <label>Описание</label>
              <input
                type="text"
                value={formData.description}
                onChange={e => setFormData(p => ({ ...p, description: e.target.value }))}
                placeholder="Краткое описание"
              />
            </div>

            <div className="form-group">
              <label>Цена (₽) *</label>
              <input
                type="number"
                min="0"
                value={formData.price}
                onChange={e => setFormData(p => ({ ...p, price: e.target.value }))}
                placeholder="800"
              />
            </div>

            <div className="form-group">
              <label>Фото *</label>
              <div className="image-upload-area">
                <input
                  type="file"
                  ref={fileInputRef}
                  id="pendant-image-input"
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
                <label htmlFor="pendant-image-input" className="image-upload-button">
                  {uploading ? 'Загрузка...' : 'Загрузить фото'}
                </label>
                {formData.image && (
                  <div
                    className="category-form-preview"
                    style={{ backgroundImage: `url(${formData.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                  />
                )}
              </div>
            </div>

            <div className="form-group">
              <label>Типы украшений *</label>
              {TYPES.map(t => {
                const checkedKey = `for_${t.key}` as 'for_necklace' | 'for_earrings' | 'for_bracelet'
                return (
                  <div key={t.key} style={{ marginBottom: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={formData[checkedKey]}
                        onChange={e => setFormData(p => ({ ...p, [checkedKey]: e.target.checked }))}
                      />
                      {t.title}
                    </label>
                  </div>
                )
              })}
            </div>

            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={formData.active}
                  onChange={e => setFormData(p => ({ ...p, active: e.target.checked }))}
                />
                Активна (видна в мини-приложении)
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

export default PendantsPage
