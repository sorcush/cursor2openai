import assert from "node:assert/strict"
import { test } from "node:test"
import { AdapterError } from "../../src/openai/errors.js"
import { isJsonFormat, normalizeRequest } from "../../src/openai/request-contract.js"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const user = { role: "user", content: "hi" }
const rejects = (body: unknown, pattern: RegExp) =>
  assert.throws(() => normalizeRequest(body, "composer-2.5"), (error: unknown) => {
    assert.ok(error instanceof AdapterError)
    assert.equal(error.status, 400)
    assert.equal(error.code, "invalid_request_error")
    assert.match(error.message, pattern)
    return true
  })

test("applies defaults for missing fields", () => {
  assert.deepEqual(normalizeRequest({ messages: [user] }, "composer-2.5"), {
    model: "composer-2.5",
    messages: [user],
    stream: false,
    includeUsage: false,
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: true,
    responseFormat: { type: "text" },
  })
})

test("honors stream, usage, tools, tool_choice, parallel_tool_calls, and response_format", () => {
  const tool = { type: "function", function: { name: "read_file" } }
  const result = normalizeRequest(
    {
      model: "gpt-5.6-sol-high",
      messages: [user],
      stream: true,
      stream_options: { include_usage: true },
      tools: [tool],
      tool_choice: { type: "function", function: { name: "read_file" } },
      parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } },
    },
    "composer-2.5",
  )
  assert.equal(result.model, "gpt-5.6-sol-high")
  assert.equal(result.stream, true)
  assert.equal(result.includeUsage, true)
  assert.deepEqual(result.tools, [tool])
  assert.deepEqual(result.toolChoice, { type: "function", function: { name: "read_file" } })
  assert.equal(result.parallelToolCalls, false)
  assert.equal(isJsonFormat(result.responseFormat), true)
})

test("ignores fields the Cursor CLI cannot honor", () => {
  const result = normalizeRequest(
    { messages: [user], reasoning_effort: "high", max_tokens: 5, temperature: 0.1, top_p: 1, stop: ["x"], seed: 1, user: "u", metadata: {}, extra: 1 },
    "composer-2.5",
  )
  assert.equal(result.model, "composer-2.5")
})

test("rejects invalid bodies and fields", () => {
  rejects(null, /JSON object/)
  rejects([], /JSON object/)
  rejects({ messages: [] }, /non-empty array/)
  rejects({ messages: [user], n: 2 }, /n = 1/)
  rejects({ messages: [user], model: 5 }, /model/)
  rejects({ messages: [{ role: "robot", content: "x" }] }, /unsupported role/)
  rejects({ messages: [{ role: "user", content: 5 }] }, /content/)
  rejects({ messages: [{ role: "tool", content: "x" }] }, /tool_call_id/)
  rejects({ messages: [{ role: "assistant", tool_calls: [{ id: "a", function: { name: "x" } }] }] }, /invalid tool call/)
  rejects({ messages: [user], tools: [{ type: "code_interpreter" }] }, /function tools/)
  rejects({ messages: [user], tool_choice: "sometimes" }, /tool_choice/)
  rejects({ messages: [user], response_format: { type: "xml" } }, /response_format/)
})

test("accepts only embedded data:image addresses", () => {
  const withImage = (url: string) => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] })
  assert.doesNotThrow(() => normalizeRequest(withImage(PNG), "composer-2.5"))
  rejects(withImage("file:///etc/passwd"), /data:image/)
  rejects(withImage("https://example.com/a.png"), /data:image/)
  rejects(withImage("data:image/svg+xml;base64,PHN2Zz4="), /data:image/)
})

test("a history with more than 10 images is rejected with a clear message", () => {
  const image = { type: "image_url", image_url: { url: PNG } }
  const messages = Array.from({ length: 11 }, () => ({ role: "user", content: [image] }))
  rejects({ messages }, /At most 10 images/)
})
