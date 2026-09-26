import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { afterEach, beforeEach, test } from "node:test"
import { promisify } from "node:util"
import { API_KEY, type Harness, startAdapter } from "../helpers/adapter-harness.js"
import { toolReplyLines } from "../helpers/agent-events.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const python = process.env.C2O_PYTHON
const run = promisify(execFile)
const SCRIPT = `
import json, sys
from openai import OpenAI
client = OpenAI(base_url=sys.argv[1] + "/v1", api_key=sys.argv[2])
stream = client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Read a.md"}],
    tools=[{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}],
    stream=True,
    stream_options={"include_usage": True},
)
text, calls, finish = "", {}, None
for chunk in stream:
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta
    if delta.content:
        text += delta.content
    for call in delta.tool_calls or []:
        entry = calls.setdefault(call.index, {"id": "", "name": "", "arguments": ""})
        entry["id"] += call.id or ""
        if call.function:
            entry["name"] += call.function.name or ""
            entry["arguments"] += call.function.arguments or ""
    finish = chunk.choices[0].finish_reason or finish
print(json.dumps({"text": text, "calls": list(calls.values()), "finish": finish}))
`

let dir: { path: string; cleanup(): Promise<void> }
let harness: Harness | undefined
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(async () => {
  await harness?.stop()
  harness = undefined
  await dir.cleanup()
})

test("the official OpenAI Python SDK parses streamed text and tool calls", { skip: !python }, async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: toolReplyLines("s1", [{ name: "read_file", arguments: { path: "a.md" } }], "Checking.\n") }] })
  const { stdout } = await run(python!, ["-c", SCRIPT, harness.url, API_KEY])
  const result = JSON.parse(stdout) as { text: string; finish: string; calls: Array<{ id: string; name: string; arguments: string }> }
  assert.equal(result.text, "Checking.\n")
  assert.equal(result.finish, "tool_calls")
  assert.equal(result.calls[0].name, "read_file")
  assert.match(result.calls[0].id, /^call_[0-9a-f]{24}$/)
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { path: "a.md" })
})
