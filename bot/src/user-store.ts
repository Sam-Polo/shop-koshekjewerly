import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const USER_CHAT_IDS_FILE = path.join(__dirname, '..', 'user-chat-ids.json')

export const userChatIds = new Set<string | number>()

export function loadUserChatIds(): void {
  try {
    if (fs.existsSync(USER_CHAT_IDS_FILE)) {
      const data = fs.readFileSync(USER_CHAT_IDS_FILE, 'utf8')
      const ids = JSON.parse(data)
      if (Array.isArray(ids)) {
        ids.forEach(id => userChatIds.add(id))
        console.log(`[loadUserChatIds] загружено ${userChatIds.size} chat_id из файла`)
      }
    }
  } catch (error: any) {
    console.warn('[loadUserChatIds] ошибка при загрузке файла:', error?.message)
  }
}

export function saveUserChatIds(): void {
  try {
    const ids = Array.from(userChatIds)
    fs.writeFileSync(USER_CHAT_IDS_FILE, JSON.stringify(ids, null, 2), 'utf8')
    console.log(`[saveUserChatIds] сохранено ${ids.length} chat_id в файл`)
  } catch (error: any) {
    console.error('[saveUserChatIds] ошибка при сохранении файла:', error?.message)
  }
}

// дебаунс: копим изменения и пишем файл один раз после затишья в 2s
// предотвращает множество синхронных writeFileSync при всплесках новых пользователей
export const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS ?? 2000)
let _saveTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    saveUserChatIds()
  }, SAVE_DEBOUNCE_MS)
}

export function addUserChatId(chatId: string | number): void {
  if (!chatId) return
  const wasNew = !userChatIds.has(chatId)
  userChatIds.add(chatId)
  if (wasNew) {
    scheduleSave()
  }
}
