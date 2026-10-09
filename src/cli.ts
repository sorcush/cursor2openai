#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { RequestQueue } from "./concurrency.js"
import { isLoopback, loadConfig } from "./config.js"
import { ConversationIndex } from "./conversation/conversation-index.js"
import { buildAgentEnv, runAgent, runAgentCommand } from "./cursor/agent-runner.js"
import { ModelFilter } from "./cursor/model-filter.js"
import { ModelCatalog, parseModelList } from "./cursor/model-list.js"
import { ensureWorkspaceReady } from "./cursor/workspace-permissions.js"
import { createLogger } from "./log.js"
import { createAdapterServer } from "./server.js"
import { runStartupChecks } from "./startup.js"
import { StartupError } from "./startup-error.js"

const main = async (): Promise<void> => {
  const home = homedir()
  const realHome = await realpath(home).catch(() => home)
  const config = loadConfig({ env: process.env, home, platform: process.platform })
  const logger = createLogger({ debugAgentOutput: config.debugLogAgentOutput })
  const agentEnv = buildAgentEnv(process.env)
  const { permissionsText } = await runStartupChecks({
    config,
    home,
    realHome,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    agentEnv,
    runCommand: runAgentCommand,
  })

  const models = new ModelCatalog({
    cacheFile: join(config.dataDir, "models-cache.json"),
    cacheMs: config.modelCacheMs,
    onWarning: logger.warn,
    fetchList: async () => {
      const result = await runAgentCommand(config.agentBin, ["--list-models"], agentEnv, 30_000)
      if (result.code !== 0) throw new Error(`agent --list-models exited with code ${result.code}`)
      return parseModelList(result.stdout)
    },
  })
  await models.init()
  const modelFilter = new ModelFilter({ file: join(config.dataDir, "model-filter.txt"), onWarning: logger.warn })
  await modelFilter.init()

  const index = await ConversationIndex.open({
    filePath: join(config.dataDir, "conversations.json"),
    ttlMs: config.conversationTtlMs,
    maxEntries: config.maxConversations,
    onWarning: logger.warn,
  })
  const tls = config.tlsCertFile && config.tlsKeyFile ? { cert: await readFile(config.tlsCertFile), key: await readFile(config.tlsKeyFile) } : undefined

  const adapter = createAdapterServer({
    apiKey: config.apiKey,
    maxBodyBytes: config.maxBodyBytes,
    queue: new RequestQueue(config),
    models,
    modelFilter,
    tls,
    chat: {
      defaultModel: config.defaultModel,
      agentBin: config.agentBin,
      workspaceDir: config.workspaceDir,
      requestTimeoutMs: config.requestTimeoutMs,
      agentEnv,
      index,
      logger,
      runAgent,
      prepareRun: () => ensureWorkspaceReady(config.workspaceDir, permissionsText),
    },
  })
  await adapter.listen(config.port, config.host)
  if (!tls && !isLoopback(config.host)) {
    logger.warn("Listening on a network address without HTTPS because CURSOR2OPENAI_ALLOW_INSECURE_HTTP is true. The API key and conversations are not encrypted.")
  }
  logger.info(`cursor2openai listening on ${tls ? "https" : "http"}://${config.host}:${config.port}/v1`)

  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    logger.info(`Received ${signal}; finishing running requests`)
    adapter
      .shutdown(30_000)
      .then(() => index.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.warn(`Shutdown failed: ${(error as Error).message}`)
          process.exit(1)
        },
      )
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

main().catch((error: unknown) => {
  if (error instanceof StartupError) {
    process.stderr.write(`cursor2openai: ${error.message}\n`)
    process.exit(1)
  }
  process.stderr.write(`cursor2openai: unexpected error: ${(error as Error).stack ?? String(error)}\n`)
  process.exit(1)
})
