import assert from "node:assert/strict"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { ModelFilter } from "../../src/cursor/model-filter.js"
import { StartupError } from "../../src/startup-error.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const IDS = ["auto", "composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high", "claude-4-sonnet"]

let dir: { path: string; cleanup(): Promise<void> }
let file: string
beforeEach(async () => {
  dir = await makeTempDir()
  file = join(dir.path, "model-filter.txt")
})
afterEach(() => dir.cleanup())

const start = async (text?: string, warnings: string[] = []): Promise<ModelFilter> => {
  if (text !== undefined) await writeFile(file, text)
  const filter = new ModelFilter({ file, onWarning: (message) => warnings.push(message) })
  await filter.init()
  return filter
}

test("hides nothing when the file does not exist", async () => {
  const filter = await start()
  assert.deepEqual(await filter.apply(IDS), IDS)
})

test("hides models whose whole name matches a pattern, ignoring comments and empty lines", async () => {
  const filter = await start("# old models\n\n  .*gpt\\-4.*  \n\n# auto\n")
  assert.deepEqual(await filter.apply(IDS), ["auto", "composer-2.5", "gpt-5.6-sol-high", "claude-4-sonnet"])
})

test("a pattern must match the whole name, not a part of it", async () => {
  const filter = await start("gpt-4\nauto\n")
  assert.deepEqual(await filter.apply(IDS), ["composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high", "claude-4-sonnet"])
})

test("matching ignores upper and lower case", async () => {
  const filter = await start("CLAUDE-.*\n")
  assert.deepEqual(await filter.apply(IDS), ["auto", "composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high"])
})

test("init refuses an invalid pattern and names its line", async () => {
  await assert.rejects(start("# comment\nauto\ngpt-(4\n"), (error: unknown) => error instanceof StartupError && /line 3/.test(error.message))
})

test("picks up file edits without a restart", async () => {
  const filter = await start("auto\n")
  assert.deepEqual(await filter.apply(IDS), ["composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high", "claude-4-sonnet"])
  await writeFile(file, "gpt-.*\n")
  assert.deepEqual(await filter.apply(IDS), ["auto", "composer-2.5", "claude-4-sonnet"])
})

test("keeps the last good patterns and warns once when the file is broken while running", async () => {
  const warnings: string[] = []
  const filter = await start("auto\n", warnings)
  await writeFile(file, "gpt-(4\n")
  const kept = ["composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high", "claude-4-sonnet"]
  assert.deepEqual(await filter.apply(IDS), kept)
  assert.deepEqual(await filter.apply(IDS), kept)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /line 1/)
})

test("shows every model again when the file is deleted while running", async () => {
  const filter = await start("auto\n")
  await rm(file)
  assert.deepEqual(await filter.apply(IDS), IDS)
})
