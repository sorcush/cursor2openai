import assert from "node:assert/strict"
import { test } from "node:test"
import { toOpenAiUsage } from "../../src/cursor/usage.js"

test("usage is omitted unless it covers the whole conversation", () => {
  assert.equal(toOpenAiUsage({ inputTokens: 10, outputTokens: 2 }, false), undefined)
  assert.equal(toOpenAiUsage(undefined, true), undefined)
  assert.equal(toOpenAiUsage({ outputTokens: 2 }, true), undefined)
})

test("prompt tokens include cached tokens", () => {
  assert.deepEqual(toOpenAiUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 5 }, true), {
    prompt_tokens: 115,
    completion_tokens: 2,
    total_tokens: 117,
  })
})
