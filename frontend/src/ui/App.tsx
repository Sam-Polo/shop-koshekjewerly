import { useEffect, useState } from 'react'
import WebApp from '@twa-dev/sdk'

type Category = {
  key: string
  title: string
}

const categories: Category[] = [
  { key: 'berries', title: 'Ягоды (special)' },
  { key: 'neck', title: 'Шея' },
  { key: 'hands', title: 'Руки' },
  { key: 'ears', title: 'Уши' },
]

const AboutUsModal = ({ onClose }: { onClose: () => void }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content" onClick={e => e.stopPropagation()}>
      <button className="modal-close" onClick={onClose}>&times;</button>
      <h3>О нас</h3>
      <p>ИП Силинская Олеся Станиславовна</p>
      <p>ИНН: 644112679372</p>
      <p>ОГРН: 318645100109495</p>
      <br />
      <p>Пока у нас нет оффлайн магазина, но мы принимаем заказы онлайн.</p>
      <p>Больше ассортимента и интересных предложений в наших социальных сетях.</p>
      <br />
      <h4>Ответы на ваши вопросы:</h4>
      <p><b>Как долго ждать?</b></p>
      <p>— изготовление и сборка занимает 2-3 дня. Изделия из special collection (ягоды) около 4-6 дней.</p>
      <p><b>Как происходит доставка?</b></p>
      <p>— По России и СНГ отправляем Сдэком до пункта выдачи, 350-450₽</p>
      <p>— В Европу отправляем ЕМС, 1500₽</p>
    </div>
  </div>
)

export default function App() {
  const [aboutModalOpen, setAboutModalOpen] = useState(false)

  useEffect(() => {
    // инициализируем тему и кнопку назад
    try {
      WebApp.ready()
      WebApp.BackButton.show()
    } catch {}
  }, [])

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">Категории</h1>
        <p className="page-header__text">Стиль, уникальность, качество и исключительно натуральные материалы.</p>
      </header>

      <section className="category-grid">
        {categories.map(card => (
          <article key={card.key} className="category-card">
            <div className="category-card__media" />
            <div className="category-card__content">
              <h2 className="category-card__title">{card.title}</h2>
            </div>
          </article>
        ))}
      </section>

      <footer className="page-footer">
        <button className="btn" onClick={() => window.open('https://t.me/semyonp88', '_blank')}>Поддержка</button>
        <button className="btn" onClick={() => setAboutModalOpen(true)}>О нас</button>
      </footer>

      {aboutModalOpen && <AboutUsModal onClose={() => setAboutModalOpen(false)} />}
    </div>
  )
}


