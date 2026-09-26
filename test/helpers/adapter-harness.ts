import { join } from "node:path"
import { RequestQueue } from "../../src/concurrency.js"
import { ConversationIndex } from "../../src/conversation/conversation-index.js"
import { buildAgentEnv, runAgent, runAgentCommand } from "../../src/cursor/agent-runner.js"
import { ModelCatalog, parseModelList } from "../../src/cursor/model-list.js"
import { ensureWorkspaceReady, prepareWorkspace } from "../../src/cursor/workspace-permissions.js"
import type { Logger, RequestLogEntry } from "../../src/log.js"
import { createAdapterServer, type ServerOptions } from "../../src/server.js"
import { createFakeAgent, type FakeAgent, type FakeScenario } from "./fake-agent.js"

export const API_KEY = "test-key-0123456789abcdef0123456789"

export type HarnessOptions = {
  dir: string
  scenarios?: FakeScenario[]
  maxBodyBytes?: number
  maxConcurrent?: number
  maxQueued?: number
  requestTimeoutMs?: number
  timeouts?: ServerOptions["timeouts"]
  tls?: { cert: Buffer; key: Buffer }
}

export type Harness = {
  url: string
  port: number
  dir: string
  agent: FakeAgent
  workspaceDir: string
  indexFile: string
  logs: RequestLogEntry[]
  permissionsText: string
  post(body: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>
  stop(): Promise<void>
}

export const startAdapter = async (options: HarnessOptions): Promise<Harness> => {
  const agent = await createFakeAgent(join(options.dir, "agent"), { scenarios: options.scenarios ?? [] })
  const workspaceDir = join(options.dir, "workspace")
  const paths = { home: "/nonexistent-home-c2o", realHome: "/nonexistent-home-c2o", platform: process.platform }
  const permissionsText = await prepareWorkspace({ workspaceDir, paths, uid: process.getuid?.() ?? 0 })
  const agentEnv = buildAgentEnv({ ...process.env, CURSOR2OPENAI_API_KEY: API_KEY })
  const models = new ModelCatalog({
    cacheFile: join(options.dir, "models-cache.json"),
    cacheMs: 60_000,
    fetchList: async () => parseModelList((await runAgentCommand(agent.bin, ["--list-models"], agentEnv, 5000)).stdout),
  })
  await models.init()
  const indexFile = join(options.dir, "data", "conversations.json")
  const index = await ConversationIndex.open({ filePath: indexFile, ttlMs: 86_400_000, maxEntries: 1000, batchDelayMs: 5 })
  const logs: RequestLogEntry[] = []
  const logger: Logger = { request: (entry) => logs.push(entry), info: () => {}, warn: () => {}, agentOutput: () => {} }
  const adapter = createAdapterServer({
    apiKey: API_KEY,
    maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
    queue: new RequestQueue({ maxConcurrent: options.maxConcurrent ?? 4, maxQueued: options.maxQueued ?? 16, queueTimeoutMs: 5000 }),
    models,
    tls: options.tls,
    timeouts: options.timeouts,
    chat: {
      defaultModel: "composer-2.5",
      agentBin: agent.bin,
      workspaceDir,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      agentEnv,
      index,
      logger,
      runAgent,
      prepareRun: () => ensureWorkspaceReady(workspaceDir, permissionsText),
    },
  })
  const port = await adapter.listen(0, "127.0.0.1")
  const url = `${options.tls ? "https" : "http"}://127.0.0.1:${port}`
  return {
    url,
    port,
    dir: options.dir,
    agent,
    workspaceDir,
    indexFile,
    logs,
    permissionsText,
    post: (body, init = {}) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...init.headers },
        body: JSON.stringify(body),
        signal: init.signal,
      }),
    stop: async () => {
      await adapter.shutdown(1000)
      await index.close()
    },
  }
}
