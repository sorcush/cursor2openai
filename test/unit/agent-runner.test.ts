import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
  AgentAbortedError,
  buildAgentArgs,
  buildAgentEnv,
  createAgentStreamParser,
  runAgent,
  runAgentCommand,
} from "../../src/cursor/agent-runner.js"
import { AdapterError } from "../../src/openai/errors.js"
import { deltaEvent, finalFlushEvent, initEvent, replyLines, resultEvent, toolFlushEvent } from "../helpers/agent-events.js"
import { createFakeAgent, type FakeScenario } from "../helpers/fake-agent.js"
import { makeTempDir } from "../helpers/temp-dir.js"

let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => dir.cleanup())

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const run = async (scenario: FakeScenario, overrides: { timeoutMs?: number; signal?: AbortSignal; model?: string } = {}) => {
  const agent = await createFakeAgent(join(dir.path, "agent"), { scenarios: [scenario] })
  const texts: string[] = []
  const promise = runAgent(
    {
      agentBin: agent.bin,
      workspaceDir: dir.path,
      model: overrides.model ?? "composer-2.5",
      prompt: "Hello from the test",
      timeoutMs: overrides.timeoutMs ?? 10_000,
      signal: overrides.signal,
      env: buildAgentEnv({ ...process.env, CURSOR2OPENAI_API_KEY: "secret" }),
    },
    (text) => texts.push(text),
  )
  return { agent, texts, promise }
}

test("builds the fixed argument list", () => {
  assert.deepEqual(buildAgentArgs({ workspaceDir: "/w", model: "m" }), [
    "--print", "--mode", "ask", "--trust", "--workspace", "/w", "--model", "m", "--output-format", "stream-json", "--stream-partial-output",
  ])
  assert.deepEqual(buildAgentArgs({ workspaceDir: "/w", model: "m", resumeSessionId: "s1" }).slice(-2), ["--resume", "s1"])
})

test("passes only the allowed environment variables", () => {
  assert.deepEqual(
    buildAgentEnv({ PATH: "/bin", HOME: "/h", CURSOR_API_KEY: "crsr", CURSOR2OPENAI_API_KEY: "secret", FOO: "x" }),
    { NO_COLOR: "1", PATH: "/bin", HOME: "/h", CURSOR_API_KEY: "crsr" },
  )
})

test("the stream parser keeps only new text events", () => {
  const texts: string[] = []
  const parser = createAgentStreamParser((text) => texts.push(text))
  const lines = [initEvent("s1"), deltaEvent("s1", "Hel"), deltaEvent("s1", "lo"), toolFlushEvent("s1", "Hello"), finalFlushEvent("s1", "Hello"), resultEvent("s1", "Hello", { inputTokens: 5, outputTokens: 1 })]
  const joined = `${lines.join("\n")}\n`
  parser.push(joined.slice(0, 40))
  parser.push(joined.slice(40))
  assert.deepEqual(texts, ["Hel", "lo"])
  assert.deepEqual(parser.finish(), { sessionId: "s1", resultText: "Hello", usage: { inputTokens: 5, outputTokens: 1 }, deltaCount: 2 })
})

const fixtureDir = new URL("../fixtures/agent/", import.meta.url).pathname
test("recorded Cursor streams: new text equals the final result", { skip: !existsSync(fixtureDir) }, () => {
  for (const name of readdirSync(fixtureDir).filter((file) => file.endsWith(".ndjson"))) {
    let streamed = ""
    const parser = createAgentStreamParser((text) => (streamed += text))
    parser.push(readFileSync(join(fixtureDir, name), "utf8"))
    const state = parser.finish()
    if (state.resultText !== undefined) assert.equal(streamed, state.resultText, name)
  }
})

test("runAgent streams text, returns the session, and sends the prompt on standard input", async () => {
  const { agent, texts, promise } = await run({ lines: replyLines("s1", "Hello") })
  const result = await promise
  assert.deepEqual(texts, ["Hello"])
  assert.equal(result.sessionId, "s1")
  const [invocation] = await agent.invocations()
  assert.equal(invocation.stdin, "Hello from the test")
  assert.equal(invocation.cwd, dir.path)
  assert.ok(!invocation.args.includes("--force"))
  assert.ok(!invocation.envKeys.includes("CURSOR2OPENAI_API_KEY"))
})

test("a failing agent becomes a classified error that keeps the raw output as detail", async () => {
  const { promise } = await run({ stderr: "Request failed with status 429", exitCode: 1 })
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AdapterError)
    assert.equal(error.code, "rate_limit_exceeded")
    assert.equal(error.detail, "Request failed with status 429")
    return true
  })
})

test("the time limit stops the agent and the processes it started", async () => {
  const { agent, promise } = await run({ hang: true, spawnChild: true }, { timeoutMs: 500 })
  await assert.rejects(promise, (error: unknown) => error instanceof AdapterError && error.status === 504)
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const pid of await agent.childPids()) assert.equal(isAlive(pid), false)
})

test("aborting stops the agent and the processes it started", async () => {
  const controller = new AbortController()
  const { agent, promise } = await run({ hang: true, spawnChild: true }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(promise, AgentAbortedError)
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const pid of await agent.childPids()) assert.equal(isAlive(pid), false)
})

test("model names that look like options are rejected without starting agent", async () => {
  const { agent, promise } = await run({ lines: [] }, { model: "--force" })
  await assert.rejects(promise, (error: unknown) => error instanceof AdapterError && error.code === "model_not_found")
  assert.deepEqual(await agent.invocations(), [])
})

test("a missing Cursor CLI gives 503", async () => {
  await assert.rejects(
    runAgent({ agentBin: join(dir.path, "missing-agent"), workspaceDir: dir.path, model: "m", prompt: "x", timeoutMs: 1000, env: {} }, () => {}),
    (error: unknown) => error instanceof AdapterError && error.code === "service_unavailable",
  )
})

test("runAgentCommand returns the exit code and output", async () => {
  const agent = await createFakeAgent(join(dir.path, "agent"), { scenarios: [] })
  const result = await runAgentCommand(agent.bin, ["--version"], buildAgentEnv(process.env), 5000)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /fake/)
})
