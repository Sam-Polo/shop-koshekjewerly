import FormData from 'form-data'
import axios from 'axios'
import { logger } from './logger.js'

// загрузка файла в Uploadcare через Direct Upload API
export async function uploadToUploadcare(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string> {
  const publicKey = process.env.UPLOADCARE_PUBLIC_KEY
  const secretKey = process.env.UPLOADCARE_SECRET_KEY

  if (!publicKey || !secretKey) {
    throw new Error('UPLOADCARE_PUBLIC_KEY и UPLOADCARE_SECRET_KEY должны быть заданы в .env')
  }

  // функция для повторной попытки загрузки
  const attemptUpload = async (retryCount = 0): Promise<any> => {
    const maxRetries = 3
    const retryDelay = 1000 * (retryCount + 1) // увеличиваем задержку: 1s, 2s, 3s

    try {
      // используем Direct Upload API согласно документации
      // https://uploadcare.com/api-refs/upload-api/
      const formData = new FormData()
      formData.append('UPLOADCARE_PUB_KEY', publicKey)
      formData.append('UPLOADCARE_STORE', '1') // '1' = сохранить файл
      formData.append('file', fileBuffer, {
        filename: fileName,
        contentType: mimeType
      })
      
      // логируем только первую попытку и повторные при ошибках
      if (retryCount === 0) {
        logger.info({ 
          fileName,
          fileSize: fileBuffer.length
        }, 'отправка файла в Uploadcare')
      }

      const response = await axios.post('https://upload.uploadcare.com/base/', formData, {
        headers: {
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000 // таймаут 30 секунд
      })

      return response
    } catch (error: any) {
      // проверяем, является ли это сетевой ошибкой (DNS, таймаут и т.д.)
      const isNetworkError = error?.code === 'ENOTFOUND' || 
                            error?.code === 'ETIMEDOUT' || 
                            error?.code === 'ECONNREFUSED' ||
                            error?.message?.includes('getaddrinfo') ||
                            error?.message?.includes('timeout')

      if (isNetworkError && retryCount < maxRetries) {
        logger.warn({ 
          error: error?.message || error?.code,
          attempt: retryCount + 1,
          fileName
        }, 'сетевая ошибка при загрузке, повторная попытка')
        
        // ждем перед повторной попыткой
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        
        // повторная попытка
        return attemptUpload(retryCount + 1)
      }
      
      // если это не сетевая ошибка или превышено количество попыток - пробрасываем ошибку
      throw error
    }
  }

  try {
    const response = await attemptUpload()

    const fileId = response.data?.file

    if (!fileId) {
      throw new Error('Uploadcare не вернул file ID')
    }

    // получаем информацию о файле для получения правильного CDN домена
    let cdnDomain = null
    try {
      const fileInfoResponse = await axios.get(`https://api.uploadcare.com/files/${fileId}/`, {
        headers: {
          'Authorization': `Uploadcare.Simple ${publicKey}:${secretKey}`
        }
      })
      
      // извлекаем домен из CDN URL, если он есть
      const cdnUrl = fileInfoResponse.data?.cdn_url || 
                     fileInfoResponse.data?.original_file_url ||
                     fileInfoResponse.data?.url
      
      if (cdnUrl) {
        // парсим URL и извлекаем домен
        // пример: https://3kk8t10amv.ucarecd.net/0b2df844-df81-4179-b752-3917ad50ec37/photo.jpg
        // нужно: https://3kk8t10amv.ucarecd.net/0b2df844-df81-4179-b752-3917ad50ec37/
        try {
          const url = new URL(cdnUrl)
          cdnDomain = url.hostname // получаем домен (3kk8t10amv.ucarecd.net)
        } catch (parseError) {
          logger.warn({ cdnUrl, error: parseError }, 'не удалось распарсить CDN URL')
        }
      }
    } catch (infoError: any) {
      logger.warn({ 
        error: infoError?.response?.data || infoError?.message, 
        status: infoError?.response?.status,
        fileId 
      }, 'не удалось получить информацию о файле из API')
    }

    // формируем правильный URL: https://{domain}/{uuid}/
    // убираем имя файла, оставляем только UUID
    const domain = cdnDomain || `${publicKey.substring(0, 11)}.ucarecdn.com`
    const fileUrl = `https://${domain}/${fileId}/`
    
    logger.info({ fileName, fileUrl }, 'файл загружен в Uploadcare')
    return fileUrl
  } catch (error: any) {
    const errorCode = error?.code || error?.response?.status
    const errorMessage = error?.response?.data || error?.message || 'unknown_error'
    
    // определяем тип ошибки для более понятного сообщения
    let userFriendlyMessage = errorMessage
    if (error?.code === 'ENOTFOUND' || error?.message?.includes('getaddrinfo')) {
      userFriendlyMessage = 'Проблема с подключением к серверу Uploadcare. Проверьте интернет-соединение.'
    } else if (error?.code === 'ETIMEDOUT' || error?.message?.includes('timeout')) {
      userFriendlyMessage = 'Превышено время ожидания ответа от Uploadcare. Попробуйте позже.'
    } else if (error?.code === 'ECONNREFUSED') {
      userFriendlyMessage = 'Не удалось подключиться к серверу Uploadcare. Попробуйте позже.'
    }
    
    logger.error({ 
      error: errorMessage,
      errorCode,
      status: error?.response?.status,
      publicKey: publicKey?.substring(0, 10) + '...',
      fileName
    }, 'ошибка при загрузке в Uploadcare')
    
    throw new Error(`Ошибка загрузки в Uploadcare: ${errorCode || 'unknown'} - ${userFriendlyMessage}`)
  }
}

