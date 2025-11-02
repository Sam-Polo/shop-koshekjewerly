import { useEffect, useState } from 'react'
import WebApp from '@twa-dev/sdk'
import React from 'react'

import berriesImage from '../../assets/berries-category.jpg'
import neckImage from '../../assets/neck-category.jpg'
import handsImage from '../../assets/hands-category.jpg'
import earsImage from '../../assets/ears-category.jpg'
import certificateImage from '../../assets/certificate-category.jpg'
import logoImage from '../../assets/logo.png'
import backgroundImage from '../../assets/background.jpg'

type Category = {
  key: string
  title: string
  description?: string
  image: string
}

const categories: Category[] = [
  { key: 'berries', title: 'Ягоды (special)', description: 'Эксклюзивная коллекция KOSHEK, украшения в виде реалистичных ягод из полимерной глины', image: berriesImage },
  { key: 'neck', title: 'Шея', description: 'Чокеры, колье, подвески, кулоны', image: neckImage },
  { key: 'hands', title: 'Руки', description: 'Браслеты, кольца', image: handsImage },
  { key: 'ears', title: 'Уши', description: 'Серьги, каффы', image: earsImage },
  { key: 'certificates', title: 'Сертификаты', image: certificateImage },
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
        <p>— по Москве и МО 350₽ сдэк</p>
        <p>— По России 500₽</p>
        <p>— СНГ (Беларусь, Казахстан, Армения и все такое) 650₽</p>
        <p>— Европа 1500₽</p>
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
    <>
      <header className="page-header" style={{ backgroundImage: `url(${backgroundImage})` }}>
        <img src={logoImage} alt="KOSHEK logo" className="header-logo" />
        <h1 className="page-header__title">KOSHEK</h1>
        <p className="page-header__text">Girls выбирают KOSHEK и бриллианты.</p>
      </header>

      <main className="page">
        <section className="category-grid">
          {categories.map(card => (
            <button key={card.key} className="category-card">
              <div className="category-card__media" style={{ backgroundImage: `url(${card.image})` }} />
              <div className="category-card__overlay" />
              <div className="category-card__content">
                <h2 className="category-card__title">{card.title}</h2>
                {card.description && <p className="category-card__description">{card.description}</p>}
              </div>
            </button>
          ))}
        </section>

        <footer className="page-footer">
          <button className="btn-text" onClick={() => window.open('https://t.me/semyonp88', '_blank')}>Поддержка</button>
          <button className="btn-text" onClick={() => setAboutModalOpen(true)}>О нас</button>
        </footer>
      </main>

      {aboutModalOpen && <AboutUsModal onClose={() => setAboutModalOpen(false)} />}
    </>
  )
}


