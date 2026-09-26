import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AdapterError } from "../openai/errors.js"
import { imageUrlOf } from "../openai/request-contract.js"
import type { ChatMessage } from "../openai/types.js"
import { imageKey, type ImagePaths } from "../prompt/prompt-builder.js"

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

const EXTENSIONS = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" } as const
type ImageType = keyof typeof EXTENSIONS

const invalid = (message: string): AdapterError => new AdapterError(400, "invalid_request_error", message)

const matchesSignature = (type: ImageType, data: Buffer): boolean => {
  switch (type) {
    case "png":
      return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case "jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    case "gif": {
      const header = data.subarray(0, 6).toString("latin1")
      return header === "GIF87a" || header === "GIF89a"
    }
    case "webp":
      return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP"
  }
}

export const decodeImageDataUrl = (url: string): { type: ImageType; extension: string; data: Buffer } => {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([\s\S]*)$/.exec(url)
  if (!match) throw invalid("Images must be embedded as data:image/png, jpeg, gif, or webp base64 addresses")
  const type = match[1] as ImageType
  const base64 = match[2]
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw invalid("Image data is not valid base64")
  }
  if ((base64.length / 4) * 3 > MAX_IMAGE_BYTES + 2) throw invalid("Each image must be at most 5 MB")
  const data = Buffer.from(base64, "base64")
  if (data.toString("base64") !== base64) throw invalid("Image data is not valid base64")
  if (data.length > MAX_IMAGE_BYTES) throw invalid("Each image must be at most 5 MB")
  if (!matchesSignature(type, data)) throw invalid(`Image data does not match the declared ${type} type`)
  return { type, extension: EXTENSIONS[type], data }
}

export type SavedImages = { paths: ImagePaths; cleanup(): Promise<void> }

export const saveImages = async (input: {
  workspaceDir: string
  requestId: string
  messages: ChatMessage[]
  fromIndex: number
}): Promise<SavedImages> => {
  const decoded: Array<{ key: string; extension: string; data: Buffer }> = []
  let total = 0
  for (let messageIndex = input.fromIndex; messageIndex < input.messages.length; messageIndex += 1) {
    const content = input.messages[messageIndex].content
    if (!Array.isArray(content)) continue
    content.forEach((part, partIndex) => {
      if (part.type !== "image_url") return
      const image = decodeImageDataUrl(imageUrlOf(part) ?? "")
      total += image.data.length
      if (total > MAX_TOTAL_IMAGE_BYTES) throw invalid("Images in one request must total at most 20 MB")
      decoded.push({ key: imageKey(messageIndex, partIndex), extension: image.extension, data: image.data })
    })
  }
  if (decoded.length === 0) return { paths: new Map(), cleanup: async () => {} }

  const relativeDir = join("attachments", input.requestId)
  const absoluteDir = join(input.workspaceDir, relativeDir)
  await mkdir(absoluteDir, { mode: 0o700 })
  const cleanup = () => rm(absoluteDir, { recursive: true, force: true })
  const paths = new Map<string, string>()
  try {
    for (const [index, image] of decoded.entries()) {
      const name = `image-${index + 1}.${image.extension}`
      await writeFile(join(absoluteDir, name), image.data, { mode: 0o600, flag: "wx" })
      paths.set(image.key, join(relativeDir, name))
    }
  } catch (error) {
    await cleanup()
    throw error
  }
  return { paths, cleanup }
}
