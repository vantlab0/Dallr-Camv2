import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  validateAndProcessReferenceImage,
  ImageValidationError,
  MAX_IMAGE_SIZE_BYTES,
} from '@/services/imageService'

describe('ImageService - validateAndProcessReferenceImage', () => {
  const originalImage = window.Image

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.Image = class {
      width = 800
      height = 600
      naturalWidth = 800
      naturalHeight = 600
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private _src = ''

      set src(val: string) {
        this._src = val
        setTimeout(() => {
          if (val.includes('invalid-corrupt')) {
            this.onerror?.()
          } else {
            this.onload?.()
          }
        }, 10)
      }

      get src() {
        return this._src
      }
    } as unknown as typeof Image
  })

  afterEach(() => {
    window.Image = originalImage
    vi.restoreAllMocks()
  })

  it('rejects empty or 0-byte files', async () => {
    const emptyFile = new File([], 'empty.png', { type: 'image/png' })
    await expect(validateAndProcessReferenceImage(emptyFile)).rejects.toThrow(
      'Selected image file is empty or corrupted.'
    )
  })

  it('rejects files larger than the maximum allowed limit', async () => {
    const largeBlob = new Blob(['x'.repeat(100)], { type: 'image/png' })
    const largeFile = new File([largeBlob], 'large.png', { type: 'image/png' })
    Object.defineProperty(largeFile, 'size', { value: MAX_IMAGE_SIZE_BYTES + 1 })

    await expect(validateAndProcessReferenceImage(largeFile)).rejects.toThrow(
      /Image size exceeds the maximum limit/
    )
  })

  it('rejects unsupported file formats like pdf or text', async () => {
    const textBlob = new Blob(['hello world'], { type: 'text/plain' })
    const textFile = new File([textBlob], 'document.txt', { type: 'text/plain' })

    await expect(validateAndProcessReferenceImage(textFile)).rejects.toThrow(
      'Unsupported image format. Please select a PNG, JPG, JPEG, or WebP image.'
    )
  })

  it('successfully validates and prepares a valid PNG image', async () => {
    const pngBlob = new Blob(['fake png data'], { type: 'image/png' })
    const pngFile = new File([pngBlob], 'portrait.png', { type: 'image/png' })

    const result = await validateAndProcessReferenceImage(pngFile)
    expect(result.name).toBe('portrait.png')
    expect(result.mimeType).toBe('image/png')
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
    expect(result.aspectRatio).toBeCloseTo(800 / 600)
    expect(result.dataUrl).toContain('data:image/png;base64,')
  })

  it('successfully validates and prepares a valid WebP image', async () => {
    const webpBlob = new Blob(['fake webp data'], { type: 'image/webp' })
    const webpFile = new File([webpBlob], 'portrait.webp', { type: 'image/webp' })

    const result = await validateAndProcessReferenceImage(webpFile)
    expect(result.name).toBe('portrait.webp')
    expect(result.mimeType).toBe('image/webp')
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })

  it('successfully validates and prepares JPG/JPEG images', async () => {
    const jpgBlob = new Blob(['fake jpg data'], { type: 'image/jpeg' })
    const jpgFile = new File([jpgBlob], 'portrait.jpg', { type: 'image/jpeg' })

    const result = await validateAndProcessReferenceImage(jpgFile)
    expect(result.name).toBe('portrait.jpg')
    expect(result.mimeType).toBe('image/jpeg')
  })

  it('throws ImageValidationError when image decoding fails', async () => {
    const corruptBlob = new Blob(['invalid-corrupt'], { type: 'image/png' })
    const corruptFile = new File([corruptBlob], 'corrupt.png', { type: 'image/png' })

    const originalFileReader = window.FileReader
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.FileReader = class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      result: string | ArrayBuffer | null = null

      readAsDataURL() {
        this.result = 'data:image/png;base64,invalid-corrupt'
        setTimeout(() => this.onload?.(), 10)
      }
    } as unknown as typeof FileReader

    await expect(validateAndProcessReferenceImage(corruptFile)).rejects.toThrow(
      ImageValidationError
    )

    window.FileReader = originalFileReader
  })
})
