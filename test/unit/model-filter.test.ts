import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
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

test("a pattern with alternatives still has to match the whole name", async () => {
  const filter = await start("auto|gpt-5\n")
  assert.deepEqual(await filter.apply(["auto", "xauto", "autox", "gpt-5", "xgpt-5", "gpt-5x"]), ["xauto", "autox", "xgpt-5", "gpt-5x"])
})

test("matching ignores upper and lower case", async () => {
  const filter = await start("CLAUDE-.*\n")
  assert.deepEqual(await filter.apply(IDS), ["auto", "composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high"])
})

test("init refuses an invalid pattern and names its line", async () => {
  await assert.rejects(start("# comment\nauto\ngpt-(4\n"), (error: unknown) => error instanceof StartupError && /line 3/.test(error.message))
})

test("init refuses a line that is not a valid pattern on its own", async () => {
  await assert.rejects(start("nomatch)|(?:.*\n"), (error: unknown) => error instanceof StartupError && /line 1/.test(error.message))
})

test("the error for an invalid pattern shows the pattern as written", async () => {
  await assert.rejects(start("gpt-(4\n"), (error: unknown) => error instanceof StartupError && error.message.includes("/gpt-(4/") && !error.message.includes("(?:"))
})

test("init refuses a filter file that exists but cannot be read", async () => {
  await mkdir(file)
  await assert.rejects(start(), StartupError)
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

test("warns again when the same broken file is saved after a fix", async () => {
  const warnings: string[] = []
  const filter = await start("auto\n", warnings)
  await writeFile(file, "gpt-(4\n")
  await filter.apply(IDS)
  await writeFile(file, "auto\n")
  await filter.apply(IDS)
  await writeFile(file, "gpt-(4\n")
  await filter.apply(IDS)
  assert.equal(warnings.length, 2)
})

test("keeps the last good patterns and warns when the file becomes unreadable while running", async () => {
  const warnings: string[] = []
  const filter = await start("auto\n", warnings)
  await rm(file)
  await mkdir(file)
  assert.deepEqual(await filter.apply(IDS), ["composer-2.5", "gpt-4.1", "gpt-4o-mini", "gpt-5.6-sol-high", "claude-4-sonnet"])
  assert.equal(warnings.length, 1)
})
