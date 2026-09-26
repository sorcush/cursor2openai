import assert from "node:assert/strict"
import { test } from "node:test"
import { canonicalJson, conversationKey, lastAssistantIndex, type KeyInput } from "../../src/conversation/fingerprint.js"
import type { ChatMessage } from "../../src/openai/types.js"

const PNG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const base = (messages: ChatMessage[], overrides: Partial<KeyInput> = {}): KeyInput => ({
  affinity: "conv-1",
  model: "composer-2.5",
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  controls: { toolChoice: "auto", parallelToolCalls: true, responseFormat: { type: "text" } },
  messages,
  ...overrides,
})
const system: ChatMessage = { role: "system", content: "You are Hermes." }
const user: ChatMessage = { role: "user", content: "Read notes.md" }
const call = { id: "call_abc", type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"notes.md\"}" } }

test("canonicalJson sorts keys and drops undefined values", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, null] } }), "{\"a\":{\"c\":[2,null]},\"b\":1}")
})

test("null and empty assistant content produce the same key", () => {
  const withNull = conversationKey(base([system, user, { role: "assistant", content: null, tool_calls: [call] }]))
  const withEmpty = conversationKey(base([system, user, { role: "assistant", content: "", tool_calls: [call] }]))
  assert.equal(withNull, withEmpty)
})

test("assistant text is compared without surrounding whitespace, user text exactly", () => {
  assert.equal(
    conversationKey(base([user, { role: "assistant", content: "Done.\n" }])),
    conversationKey(base([user, { role: "assistant", content: "Done." }])),
  )
  assert.notEqual(conversationKey(base([{ role: "user", content: "hi " }])), conversationKey(base([{ role: "user", content: "hi" }])))
})

test("images are hashed, and different images give different keys", () => {
  const key = (url: string) => conversationKey(base([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url } }] }]))
  assert.notEqual(key(PNG_A), key(PNG_B))
  assert.equal(key(PNG_A), key(PNG_A))
})

test("tool-call IDs and tool_call_id are part of the key", () => {
  const other = { ...call, id: "call_other" }
  assert.notEqual(
    conversationKey(base([user, { role: "assistant", content: "", tool_calls: [call] }])),
    conversationKey(base([user, { role: "assistant", content: "", tool_calls: [other] }])),
  )
  assert.notEqual(
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "a" }])),
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "b" }])),
  )
})

test("fields outside the canonical form are ignored", () => {
  assert.equal(
    conversationKey(base([user, { role: "assistant", content: "ok", reasoning: "thinking", reasoning_content: "t", reasoning_details: [] }])),
    conversationKey(base([user, { role: "assistant", content: "ok" }])),
  )
  assert.equal(
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "a", name: "read_file" }])),
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "a" }])),
  )
})

test("affinity, model, tools, tool order, and each control change the key", () => {
  const messages = [system, user]
  const reference = conversationKey(base(messages))
  const extraTool = { type: "function" as const, function: { name: "write_file" } }
  const variants: Partial<KeyInput>[] = [
    { affinity: "conv-2" },
    { model: "composer-2.5-fast" },
    { tools: [] },
    { tools: [extraTool, ...base(messages).tools] },
    { tools: [...base(messages).tools, extraTool] },
    { controls: { toolChoice: "none", parallelToolCalls: true, responseFormat: { type: "text" } } },
    { controls: { toolChoice: "auto", parallelToolCalls: false, responseFormat: { type: "text" } } },
    { controls: { toolChoice: "auto", parallelToolCalls: true, responseFormat: { type: "json_object" } } },
  ]
  const keys = variants.map((overrides) => conversationKey(base(messages, overrides)))
  for (const key of keys) assert.notEqual(key, reference)
  assert.notEqual(keys[3], keys[4])
})

test("system and developer roles stay distinct", () => {
  assert.notEqual(
    conversationKey(base([{ role: "system", content: "x" }])),
    conversationKey(base([{ role: "developer", content: "x" }])),
  )
})

test("a recorded tool-call reply matches the next Hermes request (probe shape)", () => {
  const first: ChatMessage[] = [system, user]
  const adapterReply: ChatMessage = { role: "assistant", content: "", tool_calls: [call] }
  const recordedKey = conversationKey(base([...first, adapterReply]))

  const hermesReplay: ChatMessage = { role: "assistant", content: "", tool_calls: [call] }
  const toolResult: ChatMessage = { role: "tool", content: "file contents", tool_call_id: "call_abc" }
  const next = [...first, hermesReplay, toolResult]
  const index = lastAssistantIndex(next)
  assert.equal(index, 2)
  assert.equal(conversationKey(base(next.slice(0, index + 1))), recordedKey)
})

test("lastAssistantIndex returns -1 without assistant messages", () => {
  assert.equal(lastAssistantIndex([system, user]), -1)
})
