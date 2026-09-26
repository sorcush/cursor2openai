import assert from "node:assert/strict"
import { mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { decodeImageDataUrl, MAX_IMAGE_BYTES, saveImages } from "../../src/images/attachments.js"
import { AdapterError } from "../../src/openai/errors.js"
import type { ChatMessage } from "../../src/openai/types.js"
import { imageKey } from "../../src/prompt/prompt-builder.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const dataUrl = (type: string, bytes: Buffer) => `data:image/${type};base64,${bytes.toString("base64")}`
const png = (size = 16) => Buffer.concat([PNG_HEADER, Buffer.alloc(size)])
const imageMessage = (url: string): ChatMessage => ({ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url } }] })
const isBadRequest = (error: unknown) => error instanceof AdapterError && error.status === 400

let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
  await mkdir(join(dir.path, "attachments"), { mode: 0o700 })
})
afterEach(() => dir.cleanup())

test("decodes each allowed image type", () => {
  assert.equal(decodeImageDataUrl(dataUrl("png", png())).extension, "png")
  assert.equal(decodeImageDataUrl(dataUrl("jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).extension, "jpg")
  assert.equal(decodeImageDataUrl(dataUrl("gif", Buffer.from("GIF89a\x01\x00", "latin1"))).extension, "gif")
  assert.equal(decodeImageDataUrl(dataUrl("webp", Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1"))).extension, "webp")
})

test("rejects invalid base64, mismatched types, and oversized images", () => {
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,iVBORw0KGgo"), isBadRequest)
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,iVBO$w0K"), isBadRequest)
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,iVBORw0KGgp="), isBadRequest)
  assert.throws(() => decodeImageDataUrl(dataUrl("png", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), /does not match/)
  assert.throws(() => decodeImageDataUrl(dataUrl("png", png(MAX_IMAGE_BYTES))), /at most 5 MB/)
})

test("saves images from fromIndex onward with private permissions, and cleans up", async () => {
  const messages = [imageMessage(dataUrl("png", png(1))), { role: "assistant" as const, content: "ok" }, imageMessage(dataUrl("png", png(2)))]
  const saved = await saveImages({ workspaceDir: dir.path, requestId: "r1", messages, fromIndex: 1 })
  assert.deepEqual([...saved.paths.entries()], [[imageKey(2, 1), join("attachments", "r1", "image-1.png")]])
  const folder = join(dir.path, "attachments", "r1")
  assert.equal((await stat(folder)).mode & 0o777, 0o700)
  assert.equal((await stat(join(folder, "image-1.png"))).mode & 0o777, 0o600)
  await saved.cleanup()
  assert.deepEqual(await readdir(join(dir.path, "attachments")), [])
})

test("creates nothing when there are no images", async () => {
  const saved = await saveImages({ workspaceDir: dir.path, requestId: "r2", messages: [{ role: "user", content: "hi" }], fromIndex: 0 })
  assert.equal(saved.paths.size, 0)
  assert.deepEqual(await readdir(join(dir.path, "attachments")), [])
})

test("refuses to reuse an existing request folder", async () => {
  await mkdir(join(dir.path, "attachments", "r3"))
  await assert.rejects(saveImages({ workspaceDir: dir.path, requestId: "r3", messages: [imageMessage(dataUrl("png", png()))], fromIndex: 0 }), /EEXIST/)
})

test("rejects more than 20 MB of images in one request", async () => {
  const large = dataUrl("png", png(Math.floor(MAX_IMAGE_BYTES * 0.9)))
  const messages = Array.from({ length: 5 }, () => imageMessage(large))
  await assert.rejects(saveImages({ workspaceDir: dir.path, requestId: "r4", messages, fromIndex: 0 }), /total at most 20 MB/)
})
