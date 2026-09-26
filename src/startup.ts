import { constants } from "node:fs"
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config.js"
import type { runAgentCommand } from "./cursor/agent-runner.js"
import { prepareWorkspace } from "./cursor/workspace-permissions.js"
import { StartupError } from "./startup-error.js"

export type StartupDeps = {
  config: Config
  home: string
  realHome: string
  platform: NodeJS.Platform
  uid: number
  agentEnv: NodeJS.ProcessEnv
  runCommand: typeof runAgentCommand
}

export const runStartupChecks = async (deps: StartupDeps): Promise<{ permissionsText: string }> => {
  const { config } = deps
  for (const file of [config.tlsCertFile, config.tlsKeyFile]) {
    if (!file) continue
    await access(file, constants.R_OK).catch(() => {
      throw new StartupError(`Cannot read the TLS file ${file}`)
    })
  }

  const version = await deps.runCommand(config.agentBin, ["--version"], deps.agentEnv, 10_000)
  if (version.code !== 0) {
    throw new StartupError(`The Cursor CLI (${config.agentBin}) is not available. Install it with: curl https://cursor.com/install -fsS | bash`)
  }
  const status = await deps.runCommand(config.agentBin, ["status"], deps.agentEnv, 15_000)
  if (status.code !== 0 || !/logged in/i.test(status.stdout) || /not logged in/i.test(status.stdout)) {
    throw new StartupError("The Cursor CLI is not logged in. Run: agent login")
  }

  await mkdir(config.dataDir, { recursive: true, mode: 0o700 })
  await chmod(config.dataDir, 0o700)
  const probe = join(config.dataDir, `.write-check-${process.pid}`)
  await writeFile(probe, "ok", { mode: 0o600 }).catch(() => {
    throw new StartupError(`Cannot write to the data folder ${config.dataDir}`)
  })
  await rm(probe, { force: true })

  const permissionsText = await prepareWorkspace({
    workspaceDir: config.workspaceDir,
    paths: { home: deps.home, realHome: deps.realHome, platform: deps.platform },
    uid: deps.uid,
  })
  return { permissionsText }
}
