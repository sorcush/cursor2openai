import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { classifyAgentFailure } from "../../src/cursor/error-classifier.js"

const classify = (stderr: string) => classifyAgentFailure({ stderr, exitCode: 1 })
const fixture = (name: string) => new URL(`../fixtures/agent/errors/${name}`, import.meta.url)

test("recognizes each documented failure", () => {
  const cases: Array<[string, number, string]> = [
    ["Error: You are not logged in. Run agent login.", 503, "service_unavailable"],
    ["Error: Invalid API key", 503, "service_unavailable"],
    ["You have reached your usage limit for this month", 429, "insufficient_quota"],
    ["Request failed with status 429: Too Many Requests", 429, "rate_limit_exceeded"],
    ["The prompt is too long: exceeds the maximum context length", 400, "context_length_exceeded"],
    ["Error: Unknown model 'no-such-model'", 404, "model_not_found"],
  ]
  for (const [stderr, status, code] of cases) {
    const error = classify(stderr)
    assert.equal(error.status, status, stderr)
    assert.equal(error.code, code, stderr)
    assert.equal(error.detail, stderr)
    assert.ok(!error.message.includes(stderr))
  }
})

test("anything else is an upstream error", () => {
  assert.equal(classify("segmentation fault").code, "upstream_error")
  assert.equal(classifyAgentFailure({ stderr: "", exitCode: null }).status, 502)
})

test("recorded Cursor samples are recognized", { skip: !existsSync(fixture("unknown-model.txt")) }, () => {
  assert.equal(classify(readFileSync(fixture("unknown-model.txt"), "utf8")).code, "model_not_found")
  const badKey = readFileSync(fixture("invalid-api-key.txt"), "utf8")
  if (badKey.trim()) assert.equal(classify(badKey).code, "service_unavailable")
})
