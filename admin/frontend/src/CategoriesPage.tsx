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
import './App.css'

type Category = {
  key: string
  title: string
  description?: string
  image: string
  image_position?: string
  order: number
}

const POSITION_PRESETS: { label: string; value: string }[] = [
  { label: 'Центр', value: '50% 50%' },
  { label: 'Верх', value: '50% 0%' },
  { label: 'Низ', value: '50% 100%' },
  { label: 'Слева', value: '0% 50%' },
  { label: 'Справа', value: '100% 50%' },
  { label: 'Верх-слева', value: '0% 0%' },
  { label: 'Верх-справа', value: '100% 0%' },
  { label: 'Низ-слева', value: '0% 100%' },
  { label: 'Низ-справа', value: '100% 100%' }
]

function ImagePositionPicker({
  imageUrl,
  value,
  onChange
}: {
  imageUrl: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="image-position-picker">
      <div className="image-position-preview">
        {imageUrl ? (
          <div
            className="image-position-preview-inner"
            style={{
              backgroundImage: `url(${imageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: value || 'center'
            }}
          />
        ) : (
          <div className="image-position-placeholder">Загрузите фото</div>
        )}
      </div>
      <div className="image-position-presets">
        <label>Положение фото (область отображения):</label>
        <div className="position-grid">
          {POSITION_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`position-btn ${value === p.value ? 'active' : ''}`}
              onClick={() => onChange(p.value)}
              title={p.label}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function SortableCategoryRow({
  category,
  onEdit,
  onDelete
}: {
  category: Category
  onEdit: () => void
  onDelete: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: category.key })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  return (
    <tr ref={setNodeRef} style={style} className={isDragging ? 'dragging' : ''}>
      <td>
        <span className="drag-handle" {...attributes} {...listeners}>⋮⋮</span>
      </td>
      <td>
        <div
          className="category-row-preview"
          style={{
            backgroundImage: category.image ? `url(${category.image})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: category.image_position || 'center'
          }}
        />
      </td>
      <td>{category.key}</td>
      <td>{category.title}</td>
      <td>{category.description || '—'}</td>
      <td>
        <button type="button" className="btn-edit" onClick={onEdit} title="Редактировать">✏️</button>
        <button type="button" className="btn-delete" onClick={onDelete} title="Убрать из мини-приложения">🗑️</button>
      </td>
    </tr>
  )
}

function CategoriesPage({
  onNavigate
}: {
  onNavigate?: (page: 'products' | 'promocodes' | 'categories') => void
}) {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Category | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [formData, setFormData] = useState<{ key: string; title: string; description: string; image: string; image_position: string }>({
    key: '',
    title: '',
    description: '',
    image: '',
    image_position: '50% 50%'
  })
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadCategories()
  }, [])

  const loadCategories = async () => {
    try {
      setLoading(true)
      const data = await api.getCategories()
      const list = (data.categories || []).map((c: Category, i: number) => ({ ...c, order: i }))
      setCategories(list)
    } catch (error: any) {
      showToast(error.message || 'Ошибка загрузки категорий', 'error')
    } finally {
      setLoading(false)
    }
  }

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type })
  }

  const handleLogout = () => {
    removeToken()
    window.location.reload()
  }

  const handleAdd = () => {
    setEditingCategory(null)
    setFormData({
      key: '',
      title: '',
      description: '',
      image: '',
      image_position: '50% 50%'
    })
    setIsModalOpen(true)
  }

  const handleEdit = (c: Category) => {
    setEditingCategory(c)
    setFormData({
      key: c.key,
      title: c.title,
      description: c.description || '',
      image: c.image || '',
      image_position: c.image_position || '50% 50%'
    })
    setIsModalOpen(true)
  }

  const handleDeleteClick = (c: Category) => {
    setDeleteConfirm(c)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return
    const key = deleteConfirm.key
    setDeleteConfirm(null)
    const next = categories.filter((c) => c.key !== key).map((c, i) => ({ ...c, order: i }))
    await saveCategories(next)
  }

  const saveCategories = async (list: Category[]) => {
    try {
      await api.saveCategories(list.map(({ key, title, description, image, image_position }) => ({
        key,
        title,
        description: description || undefined,
        image,
        image_position: image_position || 'center'
      })))
      setCategories(list)
      showToast('Категории сохранены', 'success')
      loadCategories()
    } catch (error: any) {
      showToast(error.message || 'Ошибка сохранения', 'error')
    }
  }

  const handleSave = async () => {
    const { key, title, description, image, image_position } = formData
    if (!key.trim()) {
      showToast('Укажите ключ (имя листа в таблице)', 'error')
      return
    }
    if (!title.trim()) {
      showToast('Укажите название', 'error')
      return
    }
    const normalizedKey = key.trim().toLowerCase()
    const existing = categories.find((c) => c.key.toLowerCase() === normalizedKey && c.key !== editingCategory?.key)
    if (existing) {
      showToast('Категория с таким ключом уже есть', 'error')
      return
    }

    let next: Category[]
    if (editingCategory) {
      next = categories.map((c) =>
        c.key === editingCategory.key
          ? { ...c, key: normalizedKey, title: title.trim(), description: description.trim() || undefined, image, image_position }
          : c
      )
    } else {
      next = [
        ...categories,
        { key: normalizedKey, title: title.trim(), description: description.trim() || undefined, image, image_position, order: categories.length }
      ]
    }
    await saveCategories(next)
    setIsModalOpen(false)
  }

  const handleFileUpload = async (file: File) => {
    setUploading(true)
    try {
      const url = await api.uploadImage(file)
      setFormData((prev) => ({ ...prev, image: url }))
    } catch (error: any) {
      showToast(error.message || 'Ошибка загрузки фото', 'error')
    } finally {
      setUploading(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    const file = files[0]
    if (allowed.includes(file.type.toLowerCase())) {
      handleFileUpload(file)
    } else {
      showToast('Поддерживаются JPG, PNG, WebP', 'error')
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = categories.findIndex((c) => c.key === active.id)
    const newIndex = categories.findIndex((c) => c.key === over.id)
    if (oldIndex !== -1 && newIndex !== -1) {
      const next = arrayMove(categories, oldIndex, newIndex).map((c, i) => ({ ...c, order: i }))
      setCategories(next)
      saveCategories(next)
    }
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
        <div className="header-nav">
          <button className="nav-btn" onClick={() => onNavigate?.('products')}>
            Товары
          </button>
          <button className="nav-btn" onClick={() => onNavigate?.('promocodes')}>
            Промокоды
          </button>
          <button className="nav-btn active" onClick={() => onNavigate?.('categories')}>
            Категории
          </button>
        </div>
        <div className="header-actions">
          <button className="btn btn-add" onClick={handleAdd}>
            + Добавить категорию
          </button>
          <button onClick={handleLogout} className="logout-btn">
            Выйти
          </button>
        </div>
      </header>

      <div className="categories-content">
        <p className="categories-hint">
          Категории отображаются в мини-приложении. Ключ — имя листа в Google Таблице с товарами. Удаление убирает категорию из приложения, но не удаляет лист в таблице.
        </p>
        {categories.length === 0 ? (
          <div className="empty-state">
            <p>Нет категорий. Добавьте вручную или создайте из стандартных листов.</p>
            <button
              type="button"
              className="btn btn-add"
              onClick={async () => {
                const seed: Category[] = [
                  { key: 'ягоды', title: 'Ягоды', description: '', image: '', image_position: '50% 50%', order: 0 },
                  { key: 'выпечка', title: 'Выпечка', description: '', image: '', image_position: '50% 50%', order: 1 },
                  { key: 'pets', title: 'FOR PETS', description: 'Украшения для ваших питомцев.', image: '', image_position: '50% 50%', order: 2 },
                  { key: 'шея', title: 'Шея', description: 'Чокеры, колье, подвески', image: '', image_position: '50% 50%', order: 3 },
                  { key: 'руки', title: 'Руки', description: 'Браслеты, кольца', image: '', image_position: '50% 50%', order: 4 },
                  { key: 'уши', title: 'Уши', description: 'Серьги, каффы', image: '', image_position: '50% 50%', order: 5 },
                  { key: 'сертификаты', title: 'Сертификаты', description: '', image: '', image_position: '50% 50%', order: 6 }
                ]
                await saveCategories(seed)
              }}
            >
              Создать из стандартных листов
            </button>
          </div>
        ) : (
          <div className="categories-table-wrapper">
            <table className="categories-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Фото</th>
                  <th>Ключ</th>
                  <th>Название</th>
                  <th>Описание</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={categories.map((c) => c.key)} strategy={verticalListSortingStrategy}>
                    {categories.map((category) => (
                      <SortableCategoryRow
                        key={category.key}
                        category={category}
                        onEdit={() => handleEdit(category)}
                        onDelete={() => handleDeleteClick(category)}
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
          <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Убрать категорию из приложения?</h3>
            <p>
              Категория «{deleteConfirm.title}» перестанет отображаться в мини-приложении. Лист «{deleteConfirm.key}» в Google Таблице не удаляется.
            </p>
            <div className="confirm-actions">
              <button className="btn btn-cancel" onClick={() => setDeleteConfirm(null)}>Отмена</button>
              <button className="btn btn-confirm" onClick={handleDeleteConfirm}>Убрать</button>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal-content modal-form" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsModalOpen(false)}>×</button>
            <h2>{editingCategory ? 'Редактировать категорию' : 'Добавить категорию'}</h2>
            <div className="form-group">
              <label>Ключ (имя листа в Google Таблице) *</label>
              <input
                type="text"
                value={formData.key}
                onChange={(e) => setFormData((p) => ({ ...p, key: e.target.value }))}
                placeholder="например: ягоды"
                disabled={!!editingCategory}
              />
              {editingCategory && <small>Ключ нельзя изменить</small>}
            </div>
            <div className="form-group">
              <label>Название *</label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData((p) => ({ ...p, title: e.target.value }))}
                placeholder="Ягоды"
              />
            </div>
            <div className="form-group">
              <label>Описание</label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData((p) => ({ ...p, description: e.target.value }))}
                placeholder="Эксклюзивная коллекция..."
              />
            </div>
            <div className="form-group">
              <label>Фото категории *</label>
              <div className="image-upload-area">
                <input
                  type="file"
                  ref={fileInputRef}
                  id="category-image-input"
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
                <label htmlFor="category-image-input" className="image-upload-button">
                  {uploading ? 'Загрузка...' : 'Загрузить фото'}
                </label>
                {formData.image && (
                  <div className="category-form-preview">
                    <div
                      className="category-form-preview-inner"
                      style={{
                        backgroundImage: `url(${formData.image})`,
                        backgroundSize: 'cover',
                        backgroundPosition: formData.image_position || 'center'
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="form-group">
              <ImagePositionPicker
                imageUrl={formData.image}
                value={formData.image_position}
                onChange={(v) => setFormData((p) => ({ ...p, image_position: v }))}
              />
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

export default CategoriesPage
