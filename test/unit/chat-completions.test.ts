import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import type { IndexEntry } from "../../src/conversation/conversation-index.js"
import { AgentAbortedError, type AgentRunInput, type AgentRunResult } from "../../src/cursor/agent-runner.js"
import type { RequestLogEntry } from "../../src/log.js"
import { type ChatDeps, handleChatCompletions } from "../../src/openai/chat-completions.js"
import { AdapterError } from "../../src/openai/errors.js"
import { parseSse, startServer } from "../helpers/http.js"
import { makeTempDir } from "../helpers/temp-dir.js"

type Script = (input: AgentRunInput, onText: (text: string) => void, call: number) => Promise<AgentRunResult>
const readTool = { type: "function", function: { name: "read_file", parameters: { type: "object" } } }
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]).toString("base64")}`
const markerFrom = (prompt: string) => /(TOOL_CALLS_[0-9a-f]{8})/.exec(prompt)?.[1] ?? "missing"
const block = (prompt: string, calls: unknown[]) => `<${markerFrom(prompt)}>\n${JSON.stringify(calls)}\n</${markerFrom(prompt)}>`
const reply = (text: string, sessionId = "s1"): Script => async (_input, onText) => {
  onText(text)
  return { sessionId, deltaCount: 1 }
}

let dir: { path: string; cleanup(): Promise<void> }
let server: { url: string; close(): Promise<void> }
let calls: AgentRunInput[]
let logs: RequestLogEntry[]
let entries: Map<string, IndexEntry>
let script: Script

beforeEach(async () => {
  dir = await makeTempDir()
  await mkdir(join(dir.path, "attachments"), { mode: 0o700 })
  calls = []
  logs = []
  entries = new Map()
  script = reply("Hello")
  const deps: ChatDeps = {
    defaultModel: "composer-2.5",
    agentBin: "agent",
    workspaceDir: dir.path,
    requestTimeoutMs: 5000,
    agentEnv: {},
    index: {
      take: async (key) => {
        const entry = entries.get(key)
        entries.delete(key)
        return entry
      },
      add: (key, value) => {
        entries.set(key, { ...value, lastUsedAt: 0 })
      },
    },
    models: { has: async (model) => model !== "unknown-model" },
    logger: { request: (entry) => logs.push(entry), info: () => {}, warn: () => {}, agentOutput: () => {} },
    runAgent: async (input, onText) => {
      calls.push(input)
      return script(input, onText, calls.length - 1)
    },
    prepareRun: async () => {},
  }
  server = await startServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    await handleChatCompletions(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")), deps)
  })
})
afterEach(async () => {
  await server.close()
  await dir.cleanup()
})

const post = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(`${server.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal })
const json = async (body: unknown, headers: Record<string, string> = {}) => {
  const response = await post(body, headers)
  return { status: response.status, body: (await response.json()) as any }
}
const waitForLogs = async (count: number) => {
  for (let i = 0; i < 100 && logs.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
}
const hi = [{ role: "user", content: "hi" }]

test("a new conversation runs a fresh session and is recorded", async () => {
  const result = await json({ messages: hi })
  assert.equal(result.status, 200)
  assert.equal(result.body.choices[0].message.content, "Hello")
  assert.equal(result.body.choices[0].finish_reason, "stop")
  assert.equal(calls[0].resumeSessionId, undefined)
  assert.ok(calls[0].prompt.includes("User:\nhi"))
  await waitForLogs(1)
  assert.equal(logs[0].mode, "fresh")
  assert.equal(logs[0].freshReason, "new")
  assert.equal(logs[0].recorded, true)
})

test("the next step continues the Cursor session with only the new messages", async () => {
  await json({ messages: hi })
  script = reply("Second")
  const result = await json({ messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "next" }] })
  assert.equal(result.body.choices[0].message.content, "Second")
  assert.equal(calls[1].resumeSessionId, "s1")
  assert.ok(calls[1].prompt.startsWith("User:\nnext"))
  assert.ok(!calls[1].prompt.includes("User:\nhi"))
  await waitForLogs(2)
  assert.equal(logs[1].mode, "continued")
})

test("a tool call round trip continues with the same marker", async () => {
  script = async (input, onText) => {
    onText(`Checking.\n${block(input.prompt, [{ name: "read_file", arguments: { path: "a.md" } }])}`)
    return { sessionId: "s1", deltaCount: 1 }
  }
  const first = await json({ messages: hi, tools: [readTool] })
  const message = first.body.choices[0].message
  assert.equal(first.body.choices[0].finish_reason, "tool_calls")
  assert.equal(message.content, "Checking.\n")
  assert.match(message.tool_calls[0].id, /^call_[0-9a-f]{24}$/)
  assert.deepEqual(message.tool_calls[0].function, { name: "read_file", arguments: "{\"path\":\"a.md\"}" })

  script = reply("The file says hello")
  const replay = { role: "assistant", content: "Checking.", tool_calls: message.tool_calls }
  const toolResult = { role: "tool", content: "hello", tool_call_id: message.tool_calls[0].id }
  const second = await json({ messages: [...hi, replay, toolResult], tools: [readTool] })
  assert.equal(second.body.choices[0].message.content, "The file says hello")
  assert.equal(calls[1].resumeSessionId, "s1")
  assert.equal(markerFrom(calls[1].prompt), markerFrom(calls[0].prompt))
  assert.ok(calls[1].prompt.startsWith("Tool result (read_file, id call_"))
})

test("streaming sends text, tool calls, finish, and no usage when usage is unavailable", async () => {
  script = async (input, onText) => {
    onText("Look")
    onText(`ing\n${block(input.prompt, [{ name: "read_file" }])}`)
    return { sessionId: "s1", deltaCount: 2, usage: { inputTokens: 10, outputTokens: 2 } }
  }
  const response = await post({ messages: hi, tools: [readTool], stream: true, stream_options: { include_usage: true } })
  const events = parseSse(await response.text()) as any[]
  const text = events.filter((event) => event.choices?.[0]?.delta?.content).map((event) => event.choices[0].delta.content).join("")
  assert.equal(text, "Looking\n")
  const toolChunk = events.find((event) => event.choices?.[0]?.delta?.tool_calls)
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, "read_file")
  assert.equal(events.at(-2).choices[0].finish_reason, "tool_calls")
  assert.equal(events.at(-1), "[DONE]")
  assert.ok(!events.some((event) => event.usage))
})

test("JSON response_format replies are sent as one piece without code fences", async () => {
  script = async (_input, onText) => {
    onText("```json\n{\"title\":")
    onText("\"Probe\"}\n```")
    return { sessionId: "s1", deltaCount: 2 }
  }
  const response = await post({ messages: hi, stream: true, response_format: { type: "json_object" } })
  const events = parseSse(await response.text()) as any[]
  const contents = events.filter((event) => event.choices?.[0]?.delta?.content).map((event) => event.choices[0].delta.content)
  assert.deepEqual(contents, ["{\"title\":\"Probe\"}"])
})

test("with parallel_tool_calls false, extra calls are dropped and the session is not recorded", async () => {
  script = async (input, onText) => {
    onText(block(input.prompt, [{ name: "read_file" }, { name: "read_file" }]))
    return { sessionId: "s1", deltaCount: 1 }
  }
  const result = await json({ messages: hi, tools: [readTool], parallel_tool_calls: false })
  assert.equal(result.body.choices[0].message.tool_calls.length, 1)
  await waitForLogs(1)
  assert.equal(logs[0].recorded, false)
  assert.equal(entries.size, 0)
})

test("a failed resume is retried once as a fresh session", async () => {
  await json({ messages: hi })
  script = async (input, onText, call) => {
    if (input.resumeSessionId) throw new AdapterError(502, "upstream_error", "failed", "raw")
    onText(`fresh ${call}`)
    return { sessionId: "s2", deltaCount: 1 }
  }
  const result = await json({ messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "next" }] })
  assert.equal(result.status, 200)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].resumeSessionId, undefined)
  assert.ok(calls[2].prompt.includes("User:\nhi"))
  await waitForLogs(2)
  assert.equal(logs[1].freshReason, "resume-failed")
})

test("a rate limit on a resumed run is returned without a retry", async () => {
  await json({ messages: hi })
  script = async () => {
    throw new AdapterError(429, "rate_limit_exceeded", "Cursor rate limit reached")
  }
  const result = await json({ messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "next" }] })
  assert.equal(result.status, 429)
  assert.equal(result.body.error.code, "rate_limit_exceeded")
  assert.equal(calls.length, 2)
})

test("an unknown model gives 404 and an invalid body gives 400, without running agent", async () => {
  assert.equal((await json({ model: "unknown-model", messages: hi })).status, 404)
  assert.equal((await json({ messages: [] })).status, 400)
  assert.equal(calls.length, 0)
})

test("an empty reply returns empty content with finish reason stop", async () => {
  script = async () => ({ sessionId: "s1", deltaCount: 0 })
  const result = await json({ messages: hi })
  assert.equal(result.status, 200)
  assert.equal(result.body.choices[0].message.content, "")
  assert.equal(result.body.choices[0].finish_reason, "stop")
})

test("the final result text is used when agent streamed no deltas", async () => {
  script = async () => ({ sessionId: "s1", deltaCount: 0, resultText: "From result" })
  assert.equal((await json({ messages: hi })).body.choices[0].message.content, "From result")
})

test("a retried request starts fresh instead of failing", async () => {
  await json({ messages: hi })
  const next = { messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "next" }] }
  assert.equal((await json(next)).status, 200)
  assert.equal((await json(next)).status, 200)
  assert.equal(calls[1].resumeSessionId, "s1")
  assert.equal(calls[2].resumeSessionId, undefined)
})

test("a client disconnect stops the run and records nothing", async () => {
  script = (input) =>
    new Promise((_resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new AgentAbortedError()))
    })
  const controller = new AbortController()
  const pending = post({ messages: hi }, {}, controller.signal).catch(() => undefined)
  for (let i = 0; i < 100 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await pending
  await waitForLogs(1)
  assert.equal(logs[0].status, 499)
  assert.equal(entries.size, 0)
})

test("an error after streaming started is sent as a stream event", async () => {
  script = async (_input, onText) => {
    onText("partial")
    throw new AdapterError(504, "timeout", "The Cursor CLI took too long")
  }
  const response = await post({ messages: hi, stream: true })
  const events = parseSse(await response.text()) as any[]
  assert.equal(response.status, 200)
  assert.equal(events.at(-2).error.code, "timeout")
})

test("screenshots are saved for the run and removed afterwards", async () => {
  let seenPath = ""
  script = async (input, onText) => {
    seenPath = /\[Image: ([^\]]+)\]/.exec(input.prompt)?.[1] ?? ""
    assert.ok(existsSync(join(dir.path, seenPath)))
    onText("A red square")
    return { sessionId: "s1", deltaCount: 1 }
  }
  const result = await json({ messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: PNG } }] }] })
  assert.equal(result.status, 200)
  assert.match(seenPath, /^attachments\//)
  assert.equal(existsSync(join(dir.path, seenPath)), false)
})
