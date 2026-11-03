import type { PreparedImageReference, SupportedImageMimeType } from '@/types/live'

export const SUPPORTED_IMAGE_TYPES: Record<string, SupportedImageMimeType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
}

export const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB default limit

export class ImageValidationError extends Error {
  constructor(message: string, public readonly code: 'INVALID_TYPE' | 'INVALID_SIZE' | 'DECODE_FAILED' | 'EMPTY_FILE') {
    super(message)
    this.name = 'ImageValidationError'
  }
}

/**
 * Validates file type, size, decodes the image to verify integrity,
 * and extracts Base64 + dimensions ready for Decart live pipeline.
 */
export async function validateAndProcessReferenceImage(
  file: File,
  options?: { maxSizeBytes?: number }
): Promise<PreparedImageReference> {
  if (!file || file.size === 0) {
    throw new ImageValidationError('Selected image file is empty or corrupted.', 'EMPTY_FILE')
  }

  const maxSizeBytes = options?.maxSizeBytes ?? MAX_IMAGE_SIZE_BYTES

  // 1. File Size Validation
  if (file.size > maxSizeBytes) {
    const maxMb = Math.round(maxSizeBytes / (1024 * 1024))
    throw new ImageValidationError(
      `Image size exceeds the maximum limit of ${maxMb}MB. Selected file is ${(file.size / (1024 * 1024)).toFixed(2)}MB.`,
      'INVALID_SIZE'
    )
  }

  // 2. MIME & Extension Validation
  const fileType = file.type.toLowerCase()
  const fileName = file.name.toLowerCase()
  const matchedExt = SUPPORTED_EXTENSIONS.some((ext) => fileName.endsWith(ext))

  let mimeType: SupportedImageMimeType | undefined = SUPPORTED_IMAGE_TYPES[fileType]

  if (!mimeType && matchedExt) {
    if (fileName.endsWith('.png')) mimeType = 'image/png'
    else if (fileName.endsWith('.webp')) mimeType = 'image/webp'
    else if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) mimeType = 'image/jpeg'
  }

  if (!mimeType) {
    throw new ImageValidationError(
      'Unsupported image format. Please select a PNG, JPG, JPEG, or WebP image.',
      'INVALID_TYPE'
    )
  }

  // 3. Read as Data URL
  const dataUrl = await readFileAsDataUrl(file)

  // 4. Decode Image & verify data integrity
  const { width, height } = await decodeImageDimensions(dataUrl)

  if (width <= 0 || height <= 0) {
    throw new ImageValidationError('Invalid image dimensions or corrupt image payload.', 'DECODE_FAILED')
  }

  // 5. Extract raw base64 string
  const base64PrefixMatch = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  const base64Data = base64PrefixMatch ? base64PrefixMatch[2] : ''

  return {
    file,
    name: file.name,
    size: file.size,
    mimeType,
    dataUrl,
    base64Data,
    width,
    height,
    aspectRatio: width / height,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new ImageValidationError('Could not read image file data.', 'DECODE_FAILED'))
      }
    }
    reader.onerror = () => {
      reject(new ImageValidationError('Failed to read image file from disk.', 'DECODE_FAILED'))
    }
    reader.readAsDataURL(file)
  })
}

function decodeImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      })
    }
    img.onerror = () => {
      reject(new ImageValidationError('Failed to decode image data. The file may be damaged.', 'DECODE_FAILED'))
    }
    img.src = dataUrl
  })
}
