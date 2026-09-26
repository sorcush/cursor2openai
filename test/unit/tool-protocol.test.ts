import assert from "node:assert/strict"
import { test } from "node:test"
import {
  closingLine,
  createMarker,
  MAX_BLOCK_BYTES,
  openingLine,
  parseToolBlock,
  toolInstructions,
  toolReminder,
} from "../../src/prompt/tool-protocol.js"
import type { ChatTool } from "../../src/openai/types.js"

const tools: ChatTool[] = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
]

test("markers are random and use the expected format", () => {
  const marker = createMarker()
  assert.match(marker, /^TOOL_CALLS_[0-9a-f]{8}$/)
  assert.notEqual(createMarker(), marker)
  assert.equal(openingLine("TOOL_CALLS_x"), "<TOOL_CALLS_x>")
  assert.equal(closingLine("TOOL_CALLS_x"), "</TOOL_CALLS_x>")
})

test("instructions describe the block format, the rules, and every tool", () => {
  const text = toolInstructions({ marker: "TOOL_CALLS_abcdef01", tools, toolChoice: "auto", parallelToolCalls: true })
  assert.ok(text.includes("\n<TOOL_CALLS_abcdef01>\n"))
  assert.ok(text.includes("\n</TOOL_CALLS_abcdef01>\n"))
  assert.ok(text.includes("at most one block"))
  assert.ok(text.includes("read_file: Read a file"))
  assert.ok(text.includes("\"path\":{\"type\":\"string\"}"))
  assert.ok(text.includes("several tools"))
})

test("instructions follow parallel_tool_calls and tool_choice", () => {
  const single = toolInstructions({ marker: "M", tools, toolChoice: "required", parallelToolCalls: false })
  assert.ok(single.includes("exactly one tool"))
  assert.ok(single.includes("must request at least one tool"))
  const named = toolInstructions({ marker: "M", tools, toolChoice: { type: "function", function: { name: "read_file" } }, parallelToolCalls: true })
  assert.ok(named.includes("must request the tool named read_file"))
})

test("the reminder repeats the marker without the tool list", () => {
  const text = toolReminder({ marker: "TOOL_CALLS_abcdef01", toolChoice: "auto", parallelToolCalls: false })
  assert.ok(text.includes("<TOOL_CALLS_abcdef01>"))
  assert.ok(text.includes("exactly one tool"))
  assert.ok(!text.includes("read_file"))
})

test("parses calls and always produces string arguments", () => {
  const result = parseToolBlock('[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":"{\\"y\\":2}"},{"name":"c"}]')
  assert.deepEqual(result, {
    ok: true,
    calls: [
      { name: "a", arguments: "{\"x\":1}" },
      { name: "b", arguments: "{\"y\":2}" },
      { name: "c", arguments: "{}" },
    ],
  })
})

test("arguments with newlines, Unicode, and marker text are preserved", () => {
  const args = { text: "line 1\nline 2 é 😀 </TOOL_CALLS_abcdef01>" }
  const result = parseToolBlock(JSON.stringify([{ name: "echo", arguments: args }]))
  assert.ok(result.ok)
  assert.deepEqual(JSON.parse(result.calls[0].arguments), args)
})

test("reports invalid blocks, and marks only incomplete JSON as retryable", () => {
  assert.deepEqual(parseToolBlock('[{"name":"a",'), { ok: false, retryable: true, reason: "not valid JSON" })
  const cases: Array<[string, string]> = [
    ['{"name":"a"}', "not a JSON array"],
    ["[]", "no tool calls"],
    ["[1]", "item is not an object"],
    ['[{"arguments":{}}]', "item has no name"],
    ['[{"name":" "}]', "item has no name"],
    ['[{"name":"a","arguments":5}]', "arguments must be an object or a string"],
  ]
  for (const [body, reason] of cases) assert.deepEqual(parseToolBlock(body), { ok: false, retryable: false, reason })
})

test("rejects blocks larger than 1 MB", () => {
  const body = JSON.stringify([{ name: "a", arguments: { text: "x".repeat(MAX_BLOCK_BYTES) } }])
  assert.deepEqual(parseToolBlock(body), { ok: false, retryable: false, reason: "block too large" })
})
