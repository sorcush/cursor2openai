import assert from "node:assert/strict"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { ConversationIndex } from "../../src/conversation/conversation-index.js"
import { makeTempDir } from "../helpers/temp-dir.js"

let dir: { path: string; cleanup(): Promise<void> }
let file: string
const DAY = 86_400_000
const open = (options: { now?: () => number; maxEntries?: number; onWarning?: (message: string) => void } = {}) =>
  ConversationIndex.open({ filePath: file, ttlMs: 30 * DAY, maxEntries: options.maxEntries ?? 100, batchDelayMs: 5, ...options })

beforeEach(async () => {
  dir = await makeTempDir()
  file = join(dir.path, "conversations.json")
})
afterEach(() => dir.cleanup())

test("take removes an entry and the removal is on disk before take resolves", async () => {
  const index = await open()
  index.add("k1", { sessionId: "s1", marker: "TOOL_CALLS_aaaaaaaa" })
  await index.flush()
  const entry = await index.take("k1")
  assert.equal(entry?.sessionId, "s1")
  assert.equal(await index.take("k1"), undefined)
  const reopened = await open()
  assert.equal(reopened.size(), 0)
  await index.close()
  await reopened.close()
})

test("added entries survive a restart", async () => {
  const index = await open()
  index.add("k1", { sessionId: "s1", marker: "TOOL_CALLS_aaaaaaaa" })
  await index.close()
  const reopened = await open()
  assert.deepEqual((await reopened.take("k1"))?.marker, "TOOL_CALLS_aaaaaaaa")
  await reopened.close()
})

test("interleaved adds and takes leave the file equal to memory", async () => {
  const index = await open()
  const work: Promise<unknown>[] = []
  for (let i = 0; i < 50; i += 1) {
    index.add(`k${i}`, { sessionId: `s${i}`, marker: "TOOL_CALLS_aaaaaaaa" })
    if (i % 3 === 0) work.push(index.take(`k${i}`))
  }
  await Promise.all(work)
  await index.flush()
  const saved = JSON.parse(await readFile(file, "utf8")) as { entries: Record<string, unknown> }
  assert.equal(Object.keys(saved.entries).length, index.size())
  assert.equal(saved.entries.k0, undefined)
  assert.ok(saved.entries.k1)
  await index.close()
})

test("entries older than the expiry are removed when the index opens", async () => {
  let now = 1_000 * DAY
  const index = await open({ now: () => now })
  index.add("old", { sessionId: "s1", marker: "TOOL_CALLS_aaaaaaaa" })
  await index.close()
  now += 31 * DAY
  const reopened = await open({ now: () => now })
  assert.equal(reopened.size(), 0)
  await reopened.close()
})

test("the least recently used entries are removed above the cap", async () => {
  const index = await open({ maxEntries: 2 })
  index.add("a", { sessionId: "s1", marker: "m" })
  index.add("b", { sessionId: "s2", marker: "m" })
  index.add("c", { sessionId: "s3", marker: "m" })
  assert.equal(index.size(), 2)
  assert.equal(await index.take("a"), undefined)
  await index.close()
})

test("a missing file produces a warning and an empty index", async () => {
  const warnings: string[] = []
  const index = await open({ onWarning: (message) => warnings.push(message) })
  assert.equal(index.size(), 0)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0], "No conversation index found; starting with an empty index")
  await index.close()
})

test("a corrupt file produces a warning and an empty index", async () => {
  await writeFile(file, "{not json")
  const warnings: string[] = []
  const index = await open({ onWarning: (message) => warnings.push(message) })
  assert.equal(index.size(), 0)
  assert.equal(warnings.length, 1)
  await index.close()
})

test("the index file is readable only by its owner", async () => {
  const index = await open()
  index.add("k1", { sessionId: "s1", marker: "m" })
  await index.close()
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})
