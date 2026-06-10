import fs from 'node:fs'
import path from 'node:path'

export type PendingNotificationType = 'order' | 'track'

export interface PendingNotification {
  orderId: string
  message: string
  type: PendingNotificationType
  createdAt: number
}

const FILE = path.join(process.cwd(), 'pending-notifications.json')
const store = new Map<string, PendingNotification[]>()

export function loadPendingNotifications(): void {
  try {
    if (fs.existsSync(FILE)) {
      const raw: Record<string, PendingNotification[]> = JSON.parse(fs.readFileSync(FILE, 'utf8'))
      for (const [chatId, items] of Object.entries(raw)) {
        store.set(chatId, items)
      }
    }
  } catch {}
}

function persist(): void {
  try {
    const obj: Record<string, PendingNotification[]> = {}
    for (const [k, v] of store) obj[k] = v
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch {}
}

export function addPendingNotification(chatId: string | number, notif: PendingNotification): void {
  const key = String(chatId)
  const list = store.get(key) ?? []
  // дедуп: не добавляем одинаковый orderId+type дважды
  if (!list.some(n => n.orderId === notif.orderId && n.type === notif.type)) {
    list.push(notif)
    store.set(key, list)
    persist()
  }
}

export function claimPendingNotifications(chatId: string | number): PendingNotification[] {
  const key = String(chatId)
  const list = store.get(key) ?? []
  if (list.length > 0) {
    store.delete(key)
    persist()
  }
  return list
}
