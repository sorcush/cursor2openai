import assert from "node:assert/strict"
import { chmod, mkdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { loadConfig } from "../../src/config.js"
import { runStartupChecks, type StartupDeps } from "../../src/startup.js"
import { StartupError } from "../../src/startup-error.js"
import { makeTempDir } from "../helpers/temp-dir.js"

let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => dir.cleanup())

const deps = (overrides: { env?: Record<string, string>; version?: number; status?: string } = {}): StartupDeps => ({
  config: loadConfig({
    env: {
      CURSOR2OPENAI_API_KEY: "k".repeat(32),
      CURSOR2OPENAI_DATA_DIR: join(dir.path, "data"),
      CURSOR2OPENAI_WORKSPACE_DIR: join(dir.path, "workspace"),
      ...overrides.env,
    },
    home: "/nonexistent-home-c2o",
    platform: process.platform,
    readFile: () => undefined,
  }),
  home: "/nonexistent-home-c2o",
  realHome: "/nonexistent-home-c2o",
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  agentEnv: {},
  runCommand: async (_bin, args) => {
    if (args[0] === "--version") return { code: overrides.version ?? 0, stdout: "2026.09.23", stderr: "" }
    return { code: 0, stdout: overrides.status ?? "✓ Logged in as someone@example.com", stderr: "" }
  },
})

test("passes and prepares the data folder and workspace", async () => {
  const { permissionsText } = await runStartupChecks(deps())
  assert.equal((await stat(join(dir.path, "data"))).mode & 0o777, 0o700)
  assert.equal(await readFile(join(dir.path, "workspace", ".cursor", "cli.json"), "utf8"), permissionsText)
})

test("fixes the mode of an existing data folder", async () => {
  await mkdir(join(dir.path, "data"))
  await chmod(join(dir.path, "data"), 0o755)
  await runStartupChecks(deps())
  assert.equal((await stat(join(dir.path, "data"))).mode & 0o777, 0o700)
})

test("fails with a clear message when the Cursor CLI is missing or not logged in", async () => {
  await assert.rejects(runStartupChecks(deps({ version: 127 })), (error: unknown) => error instanceof StartupError && /not available/.test(error.message))
  await assert.rejects(runStartupChecks(deps({ status: "Not logged in" })), /agent login/)
})

test("fails when a TLS file cannot be read", async () => {
  await assert.rejects(
    runStartupChecks(deps({ env: { CURSOR2OPENAI_TLS_CERT_FILE: join(dir.path, "missing.pem"), CURSOR2OPENAI_TLS_KEY_FILE: join(dir.path, "missing-key.pem") } })),
    /Cannot read the TLS file/,
  )
})
