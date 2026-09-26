import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { replyLines } from "../helpers/agent-events.js"
import { createFakeAgent } from "../helpers/fake-agent.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const KEY = "cli-test-key-0123456789abcdef012345"
const repoRoot = new URL("../../", import.meta.url).pathname
const cliPath = new URL("../../src/cli.ts", import.meta.url).pathname
let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => dir.cleanup())

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

const startCli = (env: Record<string, string>) => {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath], { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
  return { child, stderr: () => stderr }
}

test("starts, answers a request, and shuts down cleanly on SIGTERM", async () => {
  const agent = await createFakeAgent(join(dir.path, "agent"), { scenarios: [{ lines: replyLines("s1", "Hello") }] })
  const port = await freePort()
  const dataDir = join(dir.path, "data")
  const cli = startCli({
    CURSOR2OPENAI_API_KEY: KEY,
    CURSOR2OPENAI_PORT: String(port),
    CURSOR2OPENAI_DATA_DIR: dataDir,
    CURSOR2OPENAI_WORKSPACE_DIR: join(dir.path, "workspace"),
    CURSOR2OPENAI_AGENT_BIN: agent.bin,
  })
  for (let i = 0; i < 200 && !cli.stderr().includes("listening on"); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(cli.stderr().includes(`http://127.0.0.1:${port}/v1`), cli.stderr())
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(((await response.json()) as any).choices[0].message.content, "Hello")
  cli.child.kill("SIGTERM")
  const [code] = await once(cli.child, "exit")
  assert.equal(code, 0)
  assert.ok(existsSync(join(dataDir, "conversations.json")))
  assert.ok(!cli.stderr().includes("hi\""), "the prompt must not appear in logs")
})

test("exits with a clear message when the configuration is invalid", async () => {
  const cli = startCli({ CURSOR2OPENAI_DATA_DIR: join(dir.path, "data") })
  const [code] = await once(cli.child, "exit")
  assert.equal(code, 1)
  assert.match(cli.stderr(), /cursor2openai: CURSOR2OPENAI_API_KEY: is required/)
})
