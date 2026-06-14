export type ParsedItem = {
  article: string
  qty: number
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

function parseBotItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!/\[\d+\]/.test(trimmed) || !/—\s*\d+₽/.test(trimmed)) continue
    const articleMatch = trimmed.match(/\[(\d+)\]/)
    if (!articleMatch) continue
    const qtyMatch = trimmed.match(/×\s*(\d+)/)
    items.push({
      article: normalizeArticle(articleMatch[1]),
      qty: qtyMatch ? parseInt(qtyMatch[1], 10) : 1,
    })
  }
  return items
}

function parseTildaItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = []
  const re = /\((\d+)\)\s*x\s*(\d+)\s*≡\s*\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    items.push({ article: normalizeArticle(m[1]), qty: parseInt(m[2], 10) })
  }
  return items
}

// Format: "Title (0023) - 1x4390 = 4390;\nTitle (0019) - 1x6590"
function parseTilda2Items(text: string): ParsedItem[] {
  const items: ParsedItem[] = []
  const re = /\((\d+)\)\s*-\s*(\d+)x\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    items.push({ article: normalizeArticle(m[1]), qty: parseInt(m[2], 10) })
  }
  return items
}

/**
 * Parses the amoCRM composition field (774547) text into article+qty pairs.
 * Returns format='unknown' and empty items if the text is unrecognized.
 * Caller should log unrecognized entries for manual review.
 */
export function parseAmoCrmComposition(text: string): ParseResult {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { items: [], format: 'unknown' }
  const format = detectFormat(trimmed)
  if (format === 'bot') return { items: parseBotItems(trimmed), format }
  if (format === 'tilda') return { items: parseTildaItems(trimmed), format }
  if (format === 'tilda2') return { items: parseTilda2Items(trimmed), format: 'tilda' }
  return { items: [], format: 'unknown' }
}
