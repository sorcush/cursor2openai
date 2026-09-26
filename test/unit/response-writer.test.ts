import assert from "node:assert/strict"
import { test } from "node:test"
import { AdapterError } from "../../src/openai/errors.js"
import { completionBody, createResponseMeta, createToolCallId, SseWriter } from "../../src/openai/response-writer.js"
import { parseSse, startServer } from "../helpers/http.js"

const meta = { id: "chatcmpl-1", created: 100, model: "composer-2.5" }
const call = { id: "call_1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }

test("IDs use the OpenAI formats", () => {
  assert.match(createToolCallId(), /^call_[0-9a-f]{24}$/)
  assert.match(createResponseMeta("m").id, /^chatcmpl-[0-9a-f]{24}$/)
})

test("completionBody builds a chat.completion object", () => {
  assert.deepEqual(completionBody(meta, { content: "", toolCalls: [call], finishReason: "tool_calls" }), {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 100,
    model: "composer-2.5",
    choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [call] }, finish_reason: "tool_calls" }],
  })
  const withUsage = completionBody(meta, { content: "hi", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  assert.deepEqual((withUsage as { usage: unknown }).usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  assert.ok(!("tool_calls" in (withUsage as { choices: Array<{ message: object }> }).choices[0].message))
})

const stream = async (write: (writer: SseWriter) => void) => {
  const server = await startServer((_req, res) => write(new SseWriter(res, meta)))
  try {
    const response = await fetch(server.url)
    return { status: response.status, type: response.headers.get("content-type"), events: parseSse(await response.text()) }
  } finally {
    await server.close()
  }
}

test("streams text, tool calls, finish, usage, and the end marker", async () => {
  const result = await stream((writer) => {
    writer.text("Hel")
    writer.text("lo")
    writer.toolCalls([call])
    writer.finish("tool_calls", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, true)
  })
  assert.equal(result.status, 200)
  assert.match(result.type ?? "", /text\/event-stream/)
  const deltas = result.events.slice(0, 4).map((event) => (event as { choices: Array<{ delta: unknown; finish_reason: unknown }> }).choices[0])
  assert.deepEqual(deltas[0], { index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null })
  assert.deepEqual(deltas[1], { index: 0, delta: { content: "lo" }, finish_reason: null })
  assert.deepEqual(deltas[2], { index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null })
  assert.deepEqual(deltas[3], { index: 0, delta: {}, finish_reason: "tool_calls" })
  assert.deepEqual(result.events[4], { id: "chatcmpl-1", object: "chat.completion.chunk", created: 100, model: "composer-2.5", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
  assert.equal(result.events[5], "[DONE]")
})

test("the usage chunk is left out when not requested or not available", async () => {
  const notRequested = await stream((writer) => writer.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, false))
  assert.equal(notRequested.events.length, 2)
  const unavailable = await stream((writer) => writer.finish("stop", undefined, true))
  assert.equal(unavailable.events.length, 2)
  assert.deepEqual((unavailable.events[0] as { choices: Array<{ delta: unknown }> }).choices[0].delta, { role: "assistant" })
})

test("an error after streaming started is sent as an event", async () => {
  const result = await stream((writer) => {
    writer.text("partial")
    writer.error(new AdapterError(504, "timeout", "The Cursor CLI took too long"))
  })
  assert.deepEqual(result.events[1], { error: { message: "The Cursor CLI took too long", type: "timeout", code: "timeout" } })
  assert.equal(result.events[2], "[DONE]")
})
