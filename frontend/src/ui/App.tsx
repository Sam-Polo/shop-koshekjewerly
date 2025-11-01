import { useEffect, useState } from 'react'
import WebApp from '@twa-dev/sdk'
import React from 'react'

type Category = {
  key: string
  title: string
  description: string
}

const categories: Category[] = [
  { key: 'berries', title: 'Ягоды (special)', description: 'test' },
  { key: 'neck', title: 'Шея', description: 'test' },
  { key: 'hands', title: 'Руки', description: 'test' },
  { key: 'ears', title: 'Уши', description: 'test' },
]

const AccordionItem = ({ question, children }: { question: string, children: React.ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <div className="accordion-item">
      <button className={`accordion-question ${isOpen ? 'open' : ''}`} onClick={() => setIsOpen(!isOpen)}>
        {question}
        <span className={`accordion-icon ${isOpen ? 'open' : ''}`}>&#9660;</span>
      </button>
      <div className={`accordion-answer ${isOpen ? 'open' : ''}`}>
        <div className="accordion-answer-content">
          {children}
        </div>
      </div>
    </div>
  )
}

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
      <AccordionItem question="Как долго ждать?">
        <p>— изготовление и сборка занимает 2-3 дня. Изделия из special collection (ягоды) около 4-6 дней.</p>
      </AccordionItem>
      <AccordionItem question="Как происходит доставка?">
        <p>— По России и СНГ отправляем Сдэком до пункта выдачи, 350-450₽</p>
        <p>— В Европу отправляем ЕМС, 1500₽</p>
      </AccordionItem>
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
              <p className="category-card__description">{card.description}</p>
            </div>
          </article>
        ))}
      </section>

      <footer className="page-footer">
        <button className="btn-text" onClick={() => window.open('https://t.me/semyonp88', '_blank')}>Поддержка</button>
        <button className="btn-text" onClick={() => setAboutModalOpen(true)}>О нас</button>
      </footer>

      {aboutModalOpen && <AboutUsModal onClose={() => setAboutModalOpen(false)} />}
    </div>
  )
}


