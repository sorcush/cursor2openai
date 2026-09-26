#!/usr/bin/env node
// Runs the checks in docs/superpowers/specs/2026-09-25-hermes-cursor-adapter-design.md, section 15.
// Sends about 14 small requests through the real Cursor CLI.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, platform, tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"

const MODEL = process.env.CHECK_MODEL ?? "composer-2.5-fast"
const AGENT = process.env.CHECK_AGENT_BIN ?? "agent"
const ROOT = process.env.CHECK_WORKSPACE_ROOT ?? (platform() === "darwin" ? "/Users/Shared/cursor2openai-checks" : "/tmp/cursor2openai-checks")
const FIXTURES = new URL("../test/fixtures/agent/", import.meta.url).pathname
const HOME = homedir()
const REAL_HOME = realpathSync(HOME)
const results = []

const crc32 = (buffer) => {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
const redPng = () => {
  const size = 32
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 3 + 1) + 1 + x * 3
      raw[offset] = 220
      raw[offset + 1] = 20
      raw[offset + 2] = 20
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

const denyRoots = [...new Set([
  HOME,
  REAL_HOME,
  "/etc",
  "/root",
  ...(platform() === "darwin" ? [`/System/Volumes/Data${HOME}`, "/private/etc", "/System/Volumes/Data/private/etc"] : []),
])]
const permissions = {
  permissions: {
    allow: [],
    deny: ["Shell(*)", "Write(**)", "Write(/**)", "WebFetch(*)", "Mcp(*:*)", "Read(~/**)", ...denyRoots.map((root) => `Read(${root}/**)`)],
  },
}

const makeWorkspace = (name) => {
  const dir = join(ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, ".cursor"), { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, "attachments"), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, ".cursor", "cli.json"), JSON.stringify(permissions, null, 2))
  writeFileSync(join(dir, "attachments", "red.png"), redPng())
  return dir
}

const run = (args, { cwd, stdin = "", env = process.env, timeoutMs = 180_000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(AGENT, args, { cwd, env })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: String(error), events: [] })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const events = stdout.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      resolve({ code, stdout, stderr, events })
    })
    child.stdin.end(stdin)
  })

const chat = (workspace, prompt, { extraArgs = [], model = MODEL, env } = {}) =>
  run(
    ["--print", "--mode", "ask", "--trust", "--workspace", workspace, "--model", model,
      "--output-format", "stream-json", "--stream-partial-output", ...extraArgs],
    { cwd: workspace, stdin: prompt, env },
  )
const resultOf = (response) => response.events.find((event) => event.type === "result") ?? {}
const succeededTools = (response) =>
  response.events
    .filter((event) => event.type === "tool_call" && event.subtype === "completed")
    .map((event) => {
      const [name] = Object.keys(event.tool_call ?? {})
      return { name, outcome: Object.keys(event.tool_call?.[name]?.result ?? {})[0] ?? "none" }
    })
    .filter((tool) => tool.outcome === "success")
const record = (id, name, pass, details) => {
  results.push({ id, name, pass, details })
  console.log(`${pass ? "PASS" : "FAIL"}  check ${id}: ${name}`)
  if (details !== undefined) console.log(`      ${JSON.stringify(details)}`)
}
const saveFixture = (name, text) => {
  mkdirSync(join(FIXTURES, "errors"), { recursive: true })
  writeFileSync(join(FIXTURES, name), text)
}
const promptTotal = (usage) =>
  usage ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : undefined

mkdirSync(ROOT, { recursive: true, mode: 0o700 })
const version = await run(["--version"])
console.log(`Cursor CLI ${version.stdout.trim()} on ${platform()}, model ${MODEL}, workspaces in ${ROOT}`)

const resumeDir = makeWorkspace("resume")
const fresh = await chat(resumeDir, "Remember the code word ORBIT-7. Reply only: OK")
const sessionId = resultOf(fresh).session_id
const resumed = sessionId
  ? await chat(resumeDir, "What code word did I ask you to remember? Reply with the code word only.", { extraArgs: ["--resume", sessionId] })
  : { events: [], stdout: "", stderr: "no session id" }
record(1, "resume works from a new process", /ORBIT-7/.test(resultOf(resumed).result ?? ""), {
  sessionId,
  reply: resultOf(resumed).result,
  stderr: resumed.stderr.slice(0, 300),
})
saveFixture("fresh-text.ndjson", fresh.stdout)
saveFixture("resumed-text.ndjson", resumed.stdout)

makeWorkspace("resume")
const afterRecreate = sessionId
  ? await chat(resumeDir, "Repeat the code word I asked you to remember. Reply with the code word only.", { extraArgs: ["--resume", sessionId] })
  : { events: [], stderr: "" }
record(7, "resume works after the workspace is recreated", /ORBIT-7/.test(resultOf(afterRecreate).result ?? ""), {
  reply: resultOf(afterRecreate).result,
})

const imageDir = makeWorkspace("image")
const image = await chat(imageDir, "View the image file attachments/red.png in your workspace. What single color fills it? Reply with one word.")
record(2, "ask mode can view an image in the workspace", /red/i.test(resultOf(image).result ?? ""), { reply: resultOf(image).result })
saveFixture("image-read.ndjson", image.stdout)

const freshUsage = resultOf(fresh).usage
const resumedUsage = resultOf(resumed).usage
record(3, "token usage report", true, {
  resultKeys: Object.keys(resultOf(fresh)),
  freshUsage,
  resumedUsage,
  suggestion:
    freshUsage && resumedUsage
      ? promptTotal(resumedUsage) >= promptTotal(freshUsage)
        ? "resumed usage appears to include the earlier conversation: set CURSOR_USAGE_COVERS_CONVERSATION = true"
        : "resumed usage covers only the new messages: keep CURSOR_USAGE_COVERS_CONVERSATION = false"
      : "no usage reported: keep CURSOR_USAGE_COVERS_CONVERSATION = false",
})

const unknownModel = await chat(imageDir, "Reply OK", { model: "no-such-model-c2o" })
saveFixture("errors/unknown-model.txt", unknownModel.stderr)
const badKey = await chat(imageDir, "Reply OK", { env: { ...process.env, CURSOR_API_KEY: "crsr_invalid_key_for_testing" } })
saveFixture("errors/invalid-api-key.txt", badKey.stderr)
const emptyHome = join(tmpdir(), `c2o-empty-home-${randomBytes(4).toString("hex")}`)
mkdirSync(emptyHome, { recursive: true })
const noLogin = await run(["status"], { env: { PATH: process.env.PATH, HOME: emptyHome } })
saveFixture("errors/status-without-login.txt", `${noLogin.stdout}\n${noLogin.stderr}`)
rmSync(emptyHome, { recursive: true, force: true })
record(4, "error samples recorded", unknownModel.code !== 0, {
  unknownModelExit: unknownModel.code,
  badKeyExit: badKey.code,
  statusWithoutLoginExit: noLogin.code,
})

const allowed = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CURSOR_API_KEY"]
const minimalEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.includes(name)))
const minimal = await chat(imageDir, "Reply only: OK", { env: { ...minimalEnv, NO_COLOR: "1" } })
record(5, "agent runs with only the allowed environment variables", minimal.code === 0 && Boolean(resultOf(minimal).result), {
  exit: minimal.code,
  stderr: minimal.stderr.slice(0, 300),
})

const permissionsDir = makeWorkspace("permissions")
const token = `C2O-CANARY-${randomBytes(6).toString("hex")}`
const canary = join(HOME, `.c2o-check-canary-${randomBytes(4).toString("hex")}.txt`)
const writeTarget = join(tmpdir(), `c2o-check-write-${randomBytes(4).toString("hex")}.txt`)
writeFileSync(canary, `${token}\n`)
try {
  const homeRead = await chat(permissionsDir, `Read the file ${canary} and reply with its exact contents.`)
  const shell = await chat(permissionsDir, "Run the shell command `uname -a` and reply with its exact output.")
  const web = await chat(permissionsDir, "Fetch https://example.com with your web fetch tool and reply with the page title.")
  const mcp = await chat(permissionsDir, "List the MCP tools available to you, then call any one of them that only reads data, and report the result.")
  const write = await chat(permissionsDir, `Create the file ${writeTarget} containing the word test.`)
  const screenshot = await chat(permissionsDir, "View the image file attachments/red.png in your workspace. What single color fills it? Reply with one word.")
  const outcome = {
    homeReadBlocked: !homeRead.stdout.includes(token),
    shellBlocked: !succeededTools(shell).some((tool) => tool.name === "shellToolCall"),
    webFetchBlocked: !succeededTools(web).some((tool) => tool.name === "webFetchToolCall"),
    mcpBlocked: !succeededTools(mcp).some((tool) => tool.name === "mcpToolCall"),
    absoluteWriteBlocked: !existsSync(writeTarget) && write.code !== null,
    screenshotReadable: /red/i.test(resultOf(screenshot).result ?? ""),
  }
  record(6, "permissions file blocks Cursor's own tools and keeps screenshots readable", Object.values(outcome).every(Boolean), outcome)
} finally {
  rmSync(canary, { force: true })
  rmSync(writeTarget, { force: true })
}

writeFileSync(
  join(FIXTURES, `check-results-${platform()}.json`),
  `${JSON.stringify({ cliVersion: version.stdout.trim(), model: MODEL, results }, null, 2)}\n`,
)
rmSync(ROOT, { recursive: true, force: true })
const blocking = results.filter((result) => [1, 2, 6].includes(result.id) && !result.pass)
if (blocking.length > 0) {
  console.log(`\nSTOP: blocking checks failed: ${blocking.map((result) => result.id).join(", ")}. Revisit the design before implementing.`)
  process.exitCode = 1
}
