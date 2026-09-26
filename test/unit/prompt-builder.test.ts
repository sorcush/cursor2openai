import assert from "node:assert/strict"
import { test } from "node:test"
import type { NormalizedRequest } from "../../src/openai/request-contract.js"
import type { ChatMessage } from "../../src/openai/types.js"
import {
  buildContinuedPrompt,
  buildFullPrompt,
  imageKey,
  jsonInstructions,
  stripCodeFences,
  toolsActive,
} from "../../src/prompt/prompt-builder.js"

const M = "TOOL_CALLS_abcdef01"
const readTool = { type: "function" as const, function: { name: "read_file", description: "Read a file" } }
const call = { id: "call_1", type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"a.md\"}" } }
const history: ChatMessage[] = [
  { role: "system", content: "You are Hermes." },
  { role: "user", content: "Read a.md" },
  { role: "assistant", content: "", tool_calls: [call] },
  { role: "tool", content: "contents of a.md", tool_call_id: "call_1" },
]
const request = (overrides: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  model: "composer-2.5",
  messages: history,
  stream: false,
  includeUsage: false,
  tools: [readTool],
  toolChoice: "auto",
  parallelToolCalls: true,
  responseFormat: { type: "text" },
  ...overrides,
})
const noImages = new Map<string, string>()

test("the full prompt has tool instructions, system text, and the labeled conversation in order", () => {
  const prompt = buildFullPrompt(request(), M, noImages)
  const tools = prompt.indexOf(`<${M}>`)
  const system = prompt.indexOf("System instructions:\nYou are Hermes.")
  const user = prompt.indexOf("User:\nRead a.md")
  assert.ok(tools >= 0 && system > tools && user > system)
  assert.ok(prompt.includes("read_file: Read a file"))
  assert.ok(prompt.includes(`Assistant tool calls:\n[{"id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a.md\\"}"}]`))
  assert.ok(prompt.includes("Tool result (read_file, id call_1):\ncontents of a.md"))
})

test("tool instructions are left out when there are no tools or tool_choice is none", () => {
  assert.ok(!buildFullPrompt(request({ tools: [] }), M, noImages).includes(M))
  assert.ok(!buildFullPrompt(request({ toolChoice: "none" }), M, noImages).includes(M))
  assert.equal(toolsActive(request({ toolChoice: "none" })), false)
  assert.equal(toolsActive(request()), true)
})

test("a tool result without a matching call is labeled as unknown", () => {
  const prompt = buildFullPrompt(request({ messages: [{ role: "tool", content: "x", tool_call_id: "call_9" }] }), M, noImages)
  assert.ok(prompt.includes("Tool result (unknown tool, id call_9):\nx"))
})

test("JSON instructions follow response_format", () => {
  assert.equal(jsonInstructions({ type: "text" }), undefined)
  assert.match(jsonInstructions({ type: "json_object" }) ?? "", /single JSON object only/)
  const schema = jsonInstructions({ type: "json_schema", json_schema: { schema: { type: "object", required: ["title"] } } }) ?? ""
  assert.ok(schema.includes("{\"type\":\"object\",\"required\":[\"title\"]}"))
  assert.ok(buildFullPrompt(request({ responseFormat: { type: "json_object" } }), M, noImages).includes("single JSON object only"))
})

test("images are referenced inline, with one instruction to view them", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ]
  const paths = new Map([[imageKey(0, 1), "attachments/r1/image-1.png"]])
  const prompt = buildFullPrompt(request({ messages, tools: [] }), M, paths)
  assert.ok(prompt.includes("User:\nWhat is this?\n[Image: attachments/r1/image-1.png]"))
  assert.ok(prompt.includes("View each file named in an [Image: <path>] reference"))
  const withoutPath = buildFullPrompt(request({ messages, tools: [] }), M, noImages)
  assert.ok(withoutPath.includes("[Image: shown earlier in this conversation]"))
  assert.ok(!withoutPath.includes("View each file"))
})

test("the continued prompt has only the new messages and a reminder", () => {
  const prompt = buildContinuedPrompt(request(), 3, M, noImages)
  assert.ok(prompt.startsWith("Tool result (read_file, id call_1):\ncontents of a.md"))
  assert.ok(!prompt.includes("Read a.md"))
  assert.ok(!prompt.includes("You are Hermes."))
  assert.ok(!prompt.includes("Available tools:"))
  assert.ok(prompt.includes(`<${M}>`))
})

test("the continued prompt includes JSON instructions when requested", () => {
  const prompt = buildContinuedPrompt(request({ responseFormat: { type: "json_object" }, tools: [] }), 3, M, noImages)
  assert.ok(prompt.includes("single JSON object only"))
  assert.ok(!prompt.includes(M))
})

test("stripCodeFences removes one surrounding fence", () => {
  assert.equal(stripCodeFences("```json\n{\"a\":1}\n```"), "{\"a\":1}")
  assert.equal(stripCodeFences("  ```\n{\"a\":1}\n```  \n"), "{\"a\":1}")
  assert.equal(stripCodeFences("{\"a\":1}\n"), "{\"a\":1}")
  assert.equal(stripCodeFences("text with ``` inside"), "text with ``` inside")
})
