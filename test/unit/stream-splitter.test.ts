import assert from "node:assert/strict"
import { test } from "node:test"
import { StreamSplitter, type SplitterEvent } from "../../src/prompt/stream-splitter.js"
import { MAX_BLOCK_BYTES } from "../../src/prompt/tool-protocol.js"

const M = "TOOL_CALLS_abcdef01"
const collect = (splitter: StreamSplitter, chunks: string[]) => {
  const events: SplitterEvent[] = []
  for (const chunk of chunks) events.push(...splitter.push(chunk))
  const end = splitter.end()
  events.push(...end.events)
  const text = events.filter((event) => event.type === "text").map((event) => event.text).join("")
  const calls = events.flatMap((event) => (event.type === "tool_calls" ? event.calls : []))
  return { events, text, calls, summary: end.summary }
}
const block = (json: string) => `<${M}>\n${json}\n</${M}>`

test("without a marker, all text passes through immediately", () => {
  const splitter = new StreamSplitter(undefined)
  assert.deepEqual(splitter.push(`<${M}>\n`), [{ type: "text", text: `<${M}>\n` }])
})

test("plain text is sent at once, except a line that could become the marker", () => {
  const splitter = new StreamSplitter(M)
  assert.deepEqual(splitter.push("Hello\nwor"), [{ type: "text", text: "Hello\nwor" }])
  assert.deepEqual(splitter.push("\n<TOOL"), [{ type: "text", text: "\n" }])
  assert.deepEqual(splitter.push("S are fun"), [{ type: "text", text: "<TOOLS are fun" }])
})

test("a valid block becomes tool calls, with text before it kept", () => {
  const result = collect(new StreamSplitter(M), [`Let me look.\n${block('[{"name":"read_file","arguments":{"path":"a.md"}}]')}`])
  assert.equal(result.text, "Let me look.\n")
  assert.deepEqual(result.calls, [{ name: "read_file", arguments: "{\"path\":\"a.md\"}" }])
})

test("markers split across chunks at every position are detected", () => {
  const full = `Intro\n${block('[{"name":"a","arguments":{}}]')}\n`
  for (let cut = 1; cut < full.length; cut += 1) {
    const result = collect(new StreamSplitter(M), [full.slice(0, cut), full.slice(cut)])
    assert.equal(result.text, "Intro\n", `cut at ${cut}`)
    assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }], `cut at ${cut}`)
  }
})

test("text and a second block after the closing marker are dropped and counted", () => {
  const after = `\nMore text\n${block('[{"name":"b"}]')}`
  const result = collect(new StreamSplitter(M), [block('[{"name":"a"}]') + after])
  assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }])
  assert.equal(result.summary.droppedChars, after.length - 1)
})

test("a closing marker at the very end without a newline is accepted", () => {
  const result = collect(new StreamSplitter(M), [block('[{"name":"a"}]')])
  assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }])
})

test("marker text inside a JSON string does not end the block", () => {
  const json = JSON.stringify([{ name: "echo", arguments: { text: `</${M}>` } }])
  const result = collect(new StreamSplitter(M), [block(json)])
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { text: `</${M}>` })
})

test("Windows line endings are accepted", () => {
  const result = collect(new StreamSplitter(M), [`<${M}>\r\n[{"name":"a"}]\r\n</${M}>\r\n`])
  assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }])
})

test("an invalid block is returned as text, and later output passes through", () => {
  const result = collect(new StreamSplitter(M), [`${block('{"name":"a"}')}\nafter`])
  assert.equal(result.calls.length, 0)
  assert.equal(result.text, `<${M}>\n{"name":"a"}\n</${M}>\nafter`)
  assert.equal(result.summary.invalidBlockReason, "not a JSON array")
})

test("a block without a closing marker is returned as text at the end", () => {
  const result = collect(new StreamSplitter(M), [`Hi\n<${M}>\n[{"name":"a"}]`])
  assert.equal(result.text, `Hi\n<${M}>\n[{"name":"a"}]`)
  assert.equal(result.summary.invalidBlockReason, "missing closing marker")
})

test("a block over 1 MB is returned as text", () => {
  const huge = "x".repeat(MAX_BLOCK_BYTES + 10)
  const result = collect(new StreamSplitter(M), [`<${M}>\n`, huge])
  assert.equal(result.calls.length, 0)
  assert.equal(result.summary.invalidBlockReason, "block too large")
  assert.ok(result.text.endsWith(huge))
})

test("a marker line with nothing after it at the end is plain text", () => {
  assert.equal(collect(new StreamSplitter(M), [`<${M}>`]).text, `<${M}>`)
})
