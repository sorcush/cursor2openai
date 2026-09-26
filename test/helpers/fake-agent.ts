import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type FakeScenario = {
  lines?: string[]
  stderr?: string
  exitCode?: number
  lineDelayMs?: number
  hang?: boolean
  spawnChild?: boolean
}
export type FakeAgentOptions = { scenarios: FakeScenario[]; models?: string[]; loggedIn?: boolean; versionExitCode?: number }
export type FakeInvocation = { args: string[]; stdin: string; envKeys: string[]; cwd: string; pid: number }
export type FakeAgent = { bin: string; invocations(): Promise<FakeInvocation[]>; childPids(): Promise<number[]> }

const SCRIPT = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
const config = JSON.parse(__CONFIG__)
const args = process.argv.slice(2)
if (args[0] === "--version") { process.stdout.write("2026.09.23-fake\\n"); process.exit(config.versionExitCode) }
if (args[0] === "status") { process.stdout.write(config.loggedIn ? "✓ Logged in as fake@example.com\\n" : "Not logged in\\n"); process.exit(config.loggedIn ? 0 : 1) }
if (args[0] === "--list-models") { process.stdout.write("Available models\\n\\n" + config.models.map((m) => m + " - " + m).join("\\n") + "\\n"); process.exit(0) }
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", async () => {
  const count = existsSync(config.counterFile) ? Number(readFileSync(config.counterFile, "utf8")) : 0
  writeFileSync(config.counterFile, String(count + 1))
  const scenario = config.scenarios[Math.min(count, config.scenarios.length - 1)] ?? {}
  const stdin = Buffer.concat(chunks).toString("utf8")
  appendFileSync(config.logFile, JSON.stringify({ args, stdin, envKeys: Object.keys(process.env).sort(), cwd: process.cwd(), pid: process.pid }) + "\\n")
  const marker = (/(TOOL_CALLS_[0-9a-f]{8})/.exec(stdin) ?? [])[1] ?? "TOOL_CALLS_missing"
  if (scenario.spawnChild) { const child = spawn("sleep", ["60"], { stdio: "ignore" }); appendFileSync(config.childPidFile, child.pid + "\\n") }
  for (const line of scenario.lines ?? []) {
    if (scenario.lineDelayMs) await new Promise((resolve) => setTimeout(resolve, scenario.lineDelayMs))
    process.stdout.write(line.replaceAll("{{marker}}", marker).replaceAll("{{now}}", String(Date.now())) + "\\n")
  }
  if (scenario.stderr) process.stderr.write(scenario.stderr)
  if (scenario.hang) { setInterval(() => {}, 1000); return }
  process.exitCode = scenario.exitCode ?? 0
})
`

const readJsonLines = async <T>(path: string): Promise<T[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)

export const createFakeAgent = async (dir: string, options: FakeAgentOptions): Promise<FakeAgent> => {
  await mkdir(dir, { recursive: true })
  const config = {
    scenarios: options.scenarios,
    models: options.models ?? ["composer-2.5", "composer-2.5-fast"],
    loggedIn: options.loggedIn ?? true,
    versionExitCode: options.versionExitCode ?? 0,
    logFile: join(dir, "invocations.jsonl"),
    counterFile: join(dir, "counter"),
    childPidFile: join(dir, "child-pids"),
  }
  const bin = join(dir, "fake-agent.mjs")
  await writeFile(bin, SCRIPT.replace("__CONFIG__", JSON.stringify(JSON.stringify(config))))
  await chmod(bin, 0o755)
  return {
    bin,
    invocations: () => readJsonLines<FakeInvocation>(config.logFile),
    childPids: async () =>
      (await readFile(config.childPidFile, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map(Number),
  }
}
