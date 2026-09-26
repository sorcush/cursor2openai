import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { ConversationIndex } from "../../src/conversation/conversation-index.js"
import { API_KEY, type Harness, startAdapter } from "../helpers/adapter-harness.js"
import { replyLines, toolReplyLines } from "../helpers/agent-events.js"
import { makeTempDir } from "../helpers/temp-dir.js"

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

const readTool = { type: "function", function: { name: "read_file", parameters: { type: "object" } } }
const hi = [{ role: "user", content: "Read a.md" }]
const markerIn = (text: string) => /(TOOL_CALLS_[0-9a-f]{8})/.exec(text)?.[1]
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition not met in time")
}

test("rejects bad keys, CORS preflight, unknown paths, wrong methods, wrong content types, and large bodies", async () => {
  harness = await startAdapter({ dir: dir.path, maxBodyBytes: 100 })
  const call = (path: string, init: RequestInit = {}) => fetch(`${harness!.url}${path}`, init)
  const auth = { authorization: `Bearer ${API_KEY}` }
  assert.equal((await call("/v1/models")).status, 401)
  assert.equal((await call("/v1/models", { headers: { authorization: "Bearer wrong" } })).status, 401)
  const preflight = await call("/v1/chat/completions", { method: "OPTIONS" })
  assert.equal(preflight.status, 405)
  assert.equal(preflight.headers.get("access-control-allow-origin"), null)
  assert.equal((await call("/v1/other", { headers: auth })).status, 404)
  assert.equal((await call("/v1/chat/completions", { headers: auth })).status, 405)
  assert.equal((await call("/v1/models", { method: "POST", headers: auth })).status, 405)
  assert.equal((await call("/v1/chat/completions", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status, 400)
  assert.equal((await call("/v1/chat/completions", { method: "POST", headers: { ...auth, "content-type": "application/json-patch" }, body: "{}" })).status, 400)
  assert.equal((await call("/v1/chat/completions", { method: "POST", headers: { ...auth, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ messages: hi }) })).status, 200)
  const large = await call("/v1/chat/completions", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(200) }] }) })
  assert.equal(large.status, 413)
  assert.equal(((await large.json()) as { error: { code: string } }).error.code, "request_too_large")
})

test("lists the Cursor models", async () => {
  harness = await startAdapter({ dir: dir.path })
  const response = await fetch(`${harness.url}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } })
  const body = (await response.json()) as { object: string; data: Array<{ id: string; owned_by: string }> }
  assert.equal(body.object, "list")
  assert.deepEqual(body.data.map((model) => model.id), ["composer-2.5", "composer-2.5-fast"])
  assert.equal(body.data[0].owned_by, "cursor")
})

test("every request emits one metadata log line", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: replyLines("s1", "Hello") }] })
  assert.equal((await fetch(`${harness.url}/v1/models`, { headers: { authorization: "Bearer wrong" } })).status, 401)
  assert.equal(harness.logs.length, 1)
  assert.equal(harness.logs[0].route, "/v1/models")
  assert.equal(harness.logs[0].status, 401)
  assert.equal(harness.logs[0].errorClass, "invalid_api_key")
  harness.logs.length = 0
  assert.equal((await fetch(`${harness.url}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } })).status, 200)
  assert.equal(harness.logs.length, 1)
  assert.equal(harness.logs[0].route, "/v1/models")
  assert.equal(harness.logs[0].status, 200)
  harness.logs.length = 0
  await harness.post({ messages: hi })
  assert.equal(harness.logs.length, 1)
  assert.equal(harness.logs[0].status, 200)
  assert.equal(harness.logs[0].model, "composer-2.5")
})

test("a tool round trip continues the Cursor session with only the new messages", async () => {
  harness = await startAdapter({
    dir: dir.path,
    scenarios: [{ lines: toolReplyLines("s1", [{ name: "read_file", arguments: { path: "a.md" } }]) }, { lines: replyLines("s1", "It says hello") }],
  })
  const headers = { "x-cursor2openai-conversation": "conv-1" }
  const first = (await (await harness.post({ messages: hi, tools: [readTool] }, { headers })).json()) as any
  const toolCall = first.choices[0].message.tool_calls[0]
  assert.equal(toolCall.function.name, "read_file")
  const next = [...hi, { role: "assistant", content: "", tool_calls: [toolCall] }, { role: "tool", content: "hello", tool_call_id: toolCall.id }]
  const second = (await (await harness.post({ messages: next, tools: [readTool] }, { headers })).json()) as any
  assert.equal(second.choices[0].message.content, "It says hello")

  const [one, two] = await harness.agent.invocations()
  assert.ok(!one.args.includes("--resume"))
  assert.deepEqual(two.args.slice(-2), ["--resume", "s1"])
  assert.ok(two.stdin.startsWith("Tool result (read_file, id call_"))
  assert.ok(!two.stdin.includes("Read a.md"))
  assert.equal(markerIn(two.stdin), markerIn(one.stdin))
  for (const invocation of [one, two]) {
    assert.equal(invocation.cwd, harness.workspaceDir)
    assert.equal(invocation.args[invocation.args.indexOf("--workspace") + 1], harness.workspaceDir)
    for (const forbidden of ["--force", "--yolo", "--approve-mcps"]) assert.ok(!invocation.args.includes(forbidden))
    assert.ok(!invocation.envKeys.includes("CURSOR2OPENAI_API_KEY"))
  }
})

test("identical conversations with different conversation headers never share a session", async () => {
  harness = await startAdapter({
    dir: dir.path,
    scenarios: [{ lines: replyLines("sA", "Hello") }, { lines: replyLines("sB", "Hello") }, { lines: replyLines("sA", "A") }, { lines: replyLines("sB", "B") }],
  })
  const ask = (conversation: string, messages: unknown[]) => harness!.post({ messages }, { headers: { "x-cursor2openai-conversation": conversation } }).then((r) => r.json())
  await ask("A", hi)
  await ask("B", hi)
  const next = [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "more" }]
  await ask("A", next)
  await ask("B", next)
  const invocations = await harness.agent.invocations()
  assert.deepEqual(invocations[2].args.slice(-2), ["--resume", "sA"])
  assert.deepEqual(invocations[3].args.slice(-2), ["--resume", "sB"])
})

test("two parallel requests with the same key: only one continues", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: replyLines("s1", "Hello") }, { lines: replyLines("s1", "x"), lineDelayMs: 200 }] })
  await (await harness.post({ messages: hi })).json()
  const next = { messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "more" }] }
  await Promise.all([harness.post(next).then((r) => r.json()), harness.post(next).then((r) => r.json())])
  const resumed = (await harness.agent.invocations()).slice(1).filter((invocation) => invocation.args.includes("--resume"))
  assert.equal(resumed.length, 1)
})

test("the permissions file is restored before a run", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: replyLines("s1", "Hello") }] })
  const file = join(harness.workspaceDir, ".cursor", "cli.json")
  await rm(file)
  assert.equal((await harness.post({ messages: hi })).status, 200)
  assert.equal(await readFile(file, "utf8"), harness.permissionsText)
})

test("a client disconnect stops agent and its child processes", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ hang: true, spawnChild: true }] })
  const controller = new AbortController()
  const pending = harness.post({ messages: hi }, { signal: controller.signal }).catch(() => undefined)
  await waitFor(async () => (await harness!.agent.childPids()).length > 0)
  controller.abort()
  await pending
  const [child] = await harness.agent.childPids()
  await waitFor(async () => !isAlive(child))
})

test("the time limit returns 504 and stops agent and its child processes", async () => {
  harness = await startAdapter({ dir: dir.path, requestTimeoutMs: 500, scenarios: [{ hang: true, spawnChild: true }] })
  const response = await harness.post({ messages: hi })
  assert.equal(response.status, 504)
  const [child] = await harness.agent.childPids()
  await waitFor(async () => !isAlive(child))
})

test("continuation still works after the adapter restarts", async () => {
  const scenarios = [{ lines: replyLines("s1", "Hello") }, { lines: replyLines("s1", "Again") }]
  harness = await startAdapter({ dir: dir.path, scenarios })
  await (await harness.post({ messages: hi })).json()
  await harness.stop()
  harness = await startAdapter({ dir: dir.path, scenarios })
  await (await harness.post({ messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "more" }] })).json()
  const invocations = await harness.agent.invocations()
  assert.deepEqual(invocations[1].args.slice(-2), ["--resume", "s1"])
})

test("an entry used by a run that never finished is not reused after a crash", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: replyLines("s1", "Hello") }, { hang: true }] })
  await (await harness.post({ messages: hi })).json()
  const controller = new AbortController()
  const pending = harness.post({ messages: [...hi, { role: "assistant", content: "Hello" }, { role: "user", content: "more" }] }, { signal: controller.signal }).catch(() => undefined)
  await waitFor(async () => (await harness!.agent.invocations()).length === 2)
  const afterCrash = await ConversationIndex.open({ filePath: harness.indexFile, ttlMs: 86_400_000, maxEntries: 1000 })
  assert.equal(afterCrash.size(), 0)
  await afterCrash.close()
  controller.abort()
  await pending
})

test("a full queue returns 503 server_busy", async () => {
  harness = await startAdapter({ dir: dir.path, maxConcurrent: 1, maxQueued: 0, scenarios: [{ lines: replyLines("s1", "Hello"), lineDelayMs: 300 }] })
  const statuses = await Promise.all([harness.post({ messages: hi }), harness.post({ messages: [{ role: "user", content: "other" }] })].map((p) => p.then((r) => r.status)))
  assert.deepEqual(statuses.sort(), [200, 503])
})

test("a queued request aborted while waiting never runs the agent", async () => {
  harness = await startAdapter({
    dir: dir.path,
    maxConcurrent: 1,
    maxQueued: 1,
    scenarios: [{ lines: replyLines("s1", "Hello"), lineDelayMs: 300 }, { lines: replyLines("s2", "Other") }],
  })
  const first = harness.post({ messages: hi })
  await waitFor(async () => (await harness!.agent.invocations()).length === 1)
  const controller = new AbortController()
  const second = harness.post({ messages: [{ role: "user", content: "queued" }] }, { signal: controller.signal }).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await second
  await first
  assert.equal((await harness.agent.invocations()).length, 1)
})

test("shutdown rejects a queued request before it reaches the agent", async () => {
  harness = await startAdapter({
    dir: dir.path,
    maxConcurrent: 1,
    maxQueued: 1,
    scenarios: [{ lines: replyLines("s1", "Hello"), lineDelayMs: 500 }, { lines: replyLines("s2", "Other") }],
  })
  const agent = harness.agent
  const firstDone = harness.post({ messages: hi }).catch(() => undefined)
  await waitFor(async () => (await agent.invocations()).length === 1)
  let secondStatus: number | undefined
  const secondDone = harness.post({ messages: [{ role: "user", content: "queued" }] }).then(
    (response) => {
      secondStatus = response.status
    },
    () => {
      secondStatus = 0
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  await harness.stop()
  await Promise.all([secondDone, firstDone])
  harness = undefined
  assert.equal((await agent.invocations()).length, 1)
  assert.ok(secondStatus === 503 || secondStatus === 0)
})

test("a client that never finishes sending headers is disconnected", async () => {
  harness = await startAdapter({ dir: dir.path, timeouts: { headersMs: 200, requestMs: 400, keepAliveMs: 100, checkIntervalMs: 100 } })
  const socket = net.connect(harness.port, "127.0.0.1")
  socket.write("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n")
  socket.on("error", () => undefined)
  socket.resume()
  const closed = once(socket, "close")
  const timer = setTimeout(() => socket.destroy(new Error("still open")), 3000)
  await closed
  clearTimeout(timer)
})

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

test("serves HTTPS when a certificate is configured", { skip: !hasOpenssl }, async () => {
  const cert = join(dir.path, "cert.pem")
  const key = join(dir.path, "key.pem")
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" })
  harness = await startAdapter({ dir: dir.path, tls: { cert: readFileSync(cert), key: readFileSync(key) } })
  const status = await new Promise<number>((resolve, reject) => {
    https
      .get(`${harness!.url}/v1/models`, { ca: readFileSync(cert), headers: { authorization: `Bearer ${API_KEY}` } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      .on("error", reject)
  })
  assert.equal(status, 200)
})
