import { useEffect } from 'react'
import WebApp from '@twa-dev/sdk'

type CategoryCard = {
  key: string
  title: string
  description: string
}

const categoryCards: CategoryCard[] = [
  { key: 'necklaces', title: 'чокеры и колье', description: 'чокеры и колье из жемчуга, натуральных камней и природных минералов.' },
  { key: 'earrings', title: 'серьги', description: 'серьги и каффы.' },
  { key: 'pendants', title: 'подвески на цепочке', description: 'украшения на цепочке, подвески — буквы.' },
  { key: 'bracelets', title: 'браслеты', description: 'браслеты и украшения на запястья.' },
]

export default function App() {
  useEffect(() => {
    // инициализируем тему и кнопку назад
    try {
      WebApp.ready()
      WebApp.BackButton.show()
    } catch {}
  }, [])

  return (
    <div className="page">
      <header className="intro">
        <h1 className="intro__title">Категории</h1>
        <p className="intro__text">Стиль, уникальность, качество и исключительно натуральные материалы.</p>
      </header>

      <section className="category-grid">
        {categoryCards.map(card => (
          <article key={card.key} className="category-card">
            <div className="category-card__media" />
            <div className="category-card__overlay" />
            <div className="category-card__content">
              <h2 className="category-card__title">{card.title}</h2>
              <p className="category-card__description">{card.description}</p>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}


