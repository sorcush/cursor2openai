import assert from "node:assert/strict"
import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { ModelCatalog, parseModelList } from "../../src/cursor/model-list.js"
import { AdapterError } from "../../src/openai/errors.js"
import { StartupError } from "../../src/startup-error.js"
import { makeTempDir } from "../helpers/temp-dir.js"

let dir: { path: string; cleanup(): Promise<void> }
let cacheFile: string
beforeEach(async () => {
  dir = await makeTempDir()
  cacheFile = join(dir.path, "models-cache.json")
})
afterEach(() => dir.cleanup())

test("parses the agent --list-models output", () => {
  const output = "\u001b[1mAvailable models\u001b[0m\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\n- not a model\nTip: use --model <id>\n"
  assert.deepEqual(parseModelList(output), ["auto", "composer-2.5", "gpt-5.6-sol-high"])
})

test("init fetches the list, saves it privately, and has() checks exact names", async () => {
  const catalog = new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: async () => ["composer-2.5"] })
  await catalog.init()
  assert.equal(await catalog.has("composer-2.5"), true)
  assert.equal(await catalog.has("composer"), false)
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600)
})

test("init uses the saved list when fetching fails, and fails without one", async () => {
  const failing = async () => {
    throw new Error("offline")
  }
  await assert.rejects(new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: failing }).init(), StartupError)
  await writeFile(cacheFile, JSON.stringify({ ids: ["composer-2.5"] }))
  const warnings: string[] = []
  const catalog = new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: failing, onWarning: (message) => warnings.push(message) })
  await catalog.init()
  assert.deepEqual(await catalog.list(), ["composer-2.5"])
  assert.equal(warnings.length, 1)
})

test("list refreshes after the cache time and keeps the old list if a refresh fails", async () => {
  let now = 0
  let calls = 0
  let fail = false
  const catalog = new ModelCatalog({
    cacheFile,
    cacheMs: 1000,
    now: () => now,
    fetchList: async () => {
      calls += 1
      if (fail) throw new Error("offline")
      return [`model-${calls}`]
    },
  })
  await catalog.init()
  assert.deepEqual(await catalog.list(), ["model-1"])
  now = 1500
  assert.deepEqual(await catalog.list(), ["model-2"])
  fail = true
  now = 3000
  assert.deepEqual(await catalog.list(), ["model-2"])
})

test("list returns 503 when there has never been a list", async () => {
  const catalog = new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: async () => { throw new Error("offline") } })
  await assert.rejects(catalog.list(), (error: unknown) => error instanceof AdapterError && error.status === 503)
})
