export type ParsedItem = {
  article: string
  qty: number
  name: string
}

export type ParseResult = {
  items: ParsedItem[]
  format: 'bot' | 'tilda' | 'unknown'
}

/** Pads purely-numeric article codes to 4 digits: "95" → "0095", "0006" → "0006". */
export function normalizeArticle(article: string): string {
  return /^\d+$/.test(article) ? article.padStart(4, '0') : article
}

function detectFormat(text: string): 'bot' | 'tilda' | 'tilda2' | 'unknown' {
  if (/\[\d+\]/.test(text) && /—\s*\d+₽/.test(text)) return 'bot'
  if (/\(\d+\)\s*x\s*\d+\s*≡/.test(text)) return 'tilda'
  if (/\(\d+\)\s*-\s*\d+x\d+/.test(text)) return 'tilda2'
  return 'unknown'
}

// "[0095] Колье ежевика × 2 — 5990₽"
function parseBotItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!/\[\d+\]/.test(trimmed) || !/—\s*\d+₽/.test(trimmed)) continue
    const articleMatch = trimmed.match(/\[(\d+)\]/)
    if (!articleMatch) continue
    const qtyMatch = trimmed.match(/×\s*(\d+)/)
    // name is everything between "] " and " ×" or " —"
    const nameMatch = trimmed.match(/\]\s+(.+?)\s+(?:×|—)/)
    items.push({
      article: normalizeArticle(articleMatch[1]),
      qty: qtyMatch ? parseInt(qtyMatch[1], 10) : 1,
      name: nameMatch ? nameMatch[1].trim() : '',
    })
  }
  return items
}

// "Колье ежевика (0001) x 1 ≡ 10990"
function parseTildaItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = []
  const re = /(.+?)\s*\((\d+)\)\s*x\s*(\d+)\s*≡\s*\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    items.push({
      article: normalizeArticle(m[2]),
      qty: parseInt(m[3], 10),
      name: m[1].trim(),
    })
  }
  return items
}

// "Колье ежевика (0023) - 1x4390 = 4390"
function parseTilda2Items(text: string): ParsedItem[] {
  const items: ParsedItem[] = []
  const re = /(.+?)\s*\((\d+)\)\s*-\s*(\d+)x\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    items.push({
      article: normalizeArticle(m[2]),
      qty: parseInt(m[3], 10),
      name: m[1].trim(),
    })
  }
  return items
}

/**
 * Parses the amoCRM composition field (774547) text into article+qty+name triples.
 * Returns format='unknown' and empty items if the text is unrecognized.
 */
export function parseAmoCrmComposition(text: string): ParseResult {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { items: [], format: 'unknown' }
  const format = detectFormat(trimmed)
  if (format === 'bot')    return { items: parseBotItems(trimmed),    format }
  if (format === 'tilda')  return { items: parseTildaItems(trimmed),  format }
  if (format === 'tilda2') return { items: parseTilda2Items(trimmed), format: 'tilda' }
  return { items: [], format: 'unknown' }
}
