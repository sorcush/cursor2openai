# Hermes Cursor Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cursor-Plan2API code with a small, secure OpenAI Chat Completions adapter that lets Hermes Agent use a Cursor subscription through the Cursor CLI (`agent`).

**Architecture:** A Node.js HTTP(S) server exposes `POST /v1/chat/completions` and `GET /v1/models`. Each request runs one short-lived `agent --print --mode ask` process in a fixed, adapter-owned workspace protected by a Cursor permissions file. A conversation index maps an exact fingerprint of the Hermes conversation to a saved Cursor session, so continued steps run `agent --resume` with only the new messages. Tool calls are requested by the model inside a random per-session marker block and converted to OpenAI `tool_calls`; Hermes runs every tool.

**Tech Stack:** Node.js 22+, TypeScript 5 (strict, NodeNext modules), `zod`, `yaml`, Node's built-in `node:test` runner with `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-25-hermes-cursor-adapter-design.md`

## Global Constraints

- Runtime dependencies: `zod` and `yaml` only. `npm audit` must report zero vulnerabilities.
- Node.js `>=22` (needed for glob patterns in `node --test`). CI uses Node 22.
- Package, command, and environment prefix: `cursor2openai`, `cursor2openai`, `CURSOR2OPENAI_*`.
- Endpoints: only `POST /v1/chat/completions` and `GET /v1/models`.
- `agent` arguments are fixed: `--print --mode ask --trust --workspace <workspace> --model <model> --output-format stream-json --stream-partial-output [--resume <id>]`. Never `--force`, `--yolo`, or `--approve-mcps`.
- Environment given to `agent`: only `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `CURSOR_API_KEY` (when set), plus `NO_COLOR=1`.
- API key: required, at least 32 characters, compared in constant time.
- Non-loopback listening requires HTTPS unless `CURSOR2OPENAI_ALLOW_INSECURE_HTTP=true`. Loopback means `127.0.0.1`, `::1`, `localhost`.
- Workspace default: macOS `/Users/Shared/cursor2openai`, Linux `/var/lib/cursor2openai`; mode `0700`, owned by the adapter user, no symbolic links, outside every denied folder.
- Data folder default `~/.cursor2openai`, mode `0700`; files inside it mode `0600`.
- Logs never contain prompts, images, keys, or raw `agent` output unless `CURSOR2OPENAI_DEBUG_LOG_AGENT_OUTPUT=true`.
- File names use kebab-case. Comments only state constraints the code cannot show.

## Notes on the Spec

These are small, deliberate refinements discovered while planning. They do not change any decision in the spec.

- **Assistant text is trimmed in the conversation key.** Hermes strips surrounding whitespace from assistant text before storing and replaying it (`agent/chat_completion_helpers.py`, `_assistant_content_for_storage`). The key therefore trims assistant `content`. User, system, and tool text stay exact.
- **An extra error code, `internal_error` (500),** is used for unexpected adapter bugs. The spec's table covers only expected failures.
- **Server timeouts are parameters** with the spec's values as defaults, so tests can use short values.
- **Image references are written inline** as `[Image: <relative path>]` inside the message where the image appeared, followed by one instruction line asking the model to view them.

## Review Focus

1. **A Hermes history with more than 10 images.** Expected: a 400 error whose message says at most 10 images are allowed. Test added in Task 8.
2. **Hermes retries the same request after a network error.** Expected: the retry starts a fresh Cursor session and succeeds; it never fails because the entry was already used. Test added in Task 16.
3. **The model returns no text and no tool calls.** Expected: 200 with `content: ""` and finish reason `stop`, recorded normally. Test added in Task 16.
4. **Tool-call arguments containing newlines, Unicode, or the marker text.** Expected: arguments reach Hermes byte-for-byte. Tests added in Tasks 6 and 7.
5. **The Cursor CLI disappears after startup.** Expected: 503 `service_unavailable`, not a crash. Test added in Task 12.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/pre-implementation-checks.mjs` | Runs spec section 15 checks against the real Cursor CLI and records test fixtures. |
| `scripts/hermes-probe-server.mjs` | Recording HTTPS server for repeating the Hermes probe (spec section 15, check 8). |
| `src/startup-error.ts` | `StartupError` class for configuration and startup failures. |
| `src/openai/errors.ts` | `AdapterError`, error codes, OpenAI error body. |
| `src/openai/types.ts` | Chat Completions request and response types. |
| `src/config.ts` | Loads and validates configuration. |
| `src/conversation/fingerprint.ts` | Canonical message form and conversation keys. |
| `src/conversation/conversation-index.ts` | Durable, serialized, one-time-use index of Cursor sessions. |
| `src/prompt/tool-protocol.ts` | Markers, tool instructions, tool block parser. |
| `src/prompt/stream-splitter.ts` | Splits streamed output into text and one tool block. |
| `src/openai/request-contract.ts` | Validates and normalizes request fields. |
| `src/prompt/prompt-builder.ts` | Full and continued prompts, JSON instructions, code-fence removal. |
| `src/images/attachments.ts` | Decodes, checks, saves, and deletes screenshots. |
| `src/cursor/workspace-permissions.ts` | Permissions file rules, workspace preparation and verification. |
| `src/cursor/error-classifier.ts` | Maps `agent` failures to `AdapterError`. |
| `src/cursor/agent-runner.ts` | Runs `agent`, parses and de-duplicates its stream, stops process trees. |
| `src/cursor/usage.ts` | Maps Cursor usage to OpenAI usage when it covers the whole conversation. |
| `src/cursor/model-list.ts` | Fetches, caches, and checks model names. |
| `src/openai/response-writer.ts` | JSON responses, SSE writer, IDs. |
| `src/concurrency.ts` | Request queue with limits. |
| `src/log.ts` | Structured metadata logging. |
| `src/openai/chat-completions.ts` | The chat request handler. |
| `src/server.ts` | HTTP(S) server, routing, auth, body limits, timeouts, shutdown. |
| `src/startup.ts` | Startup checks 3 to 10. |
| `src/cli.ts` | Entry point. |
| `test/helpers/*.ts` | Temporary folders, fake `agent`, agent event builders, HTTP helpers. |
| `test/unit/*.test.ts`, `test/integration/*.test.ts`, `test/performance/*.test.ts` | Tests. |

---

### Task 1: Pre-implementation checks and fixtures

Runs spec section 15 checks 1 to 7 against the real Cursor CLI on this Mac and records sample output used by later tests. About 14 small requests with `composer-2.5-fast`.

**Files:**
- Create: `scripts/pre-implementation-checks.mjs`
- Create (by running the script): `test/fixtures/agent/fresh-text.ndjson`, `resumed-text.ndjson`, `image-read.ndjson`, `errors/unknown-model.txt`, `errors/invalid-api-key.txt`, `errors/status-without-login.txt`, `check-results-darwin.json`

**Interfaces:**
- Consumes: nothing.
- Produces: fixture files above. Later tasks read them if present. The value of `CURSOR_USAGE_COVERS_CONVERSATION` in Task 13 comes from check 3.

- [ ] **Step 1: Write the script**

```javascript
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
```

- [ ] **Step 2: Run the checks**

Run: `node scripts/pre-implementation-checks.mjs`
Expected: `PASS` for checks 1, 2, 5, 6, and 7, and check 3 prints a `suggestion`. The command exits 0.

If check 1, 2, or 6 fails, stop here and report the output to the user. The design depends on them (spec section 15). If check 7 fails, continue; Task 20 documents the effect.

- [ ] **Step 3: Record the usage decision**

Read the `suggestion` field of check 3 in `test/fixtures/agent/check-results-darwin.json`. Write it down for Task 13, which sets `CURSOR_USAGE_COVERS_CONVERSATION` accordingly.

- [ ] **Step 4: Inspect fixtures for private data**

Run: `grep -rlE "$(whoami)|@" test/fixtures/agent || true`
Expected: no output, or only matches you have confirmed are harmless. Remove any line that contains private data before committing.

- [ ] **Step 5: Commit**

```bash
git add scripts/pre-implementation-checks.mjs test/fixtures/agent
git commit -m "test: add pre-implementation checks and Cursor CLI fixtures"
```

---

### Task 2: Remove the old code and set up the new project skeleton

**Files:**
- Delete: `src/` (all existing files), `scripts/edge-test.mjs`, `scripts/full-test.mjs`, `scripts/model-matrix-test.mjs`, `scripts/sync-catalog-check.mjs`, `deploy/`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `opencode.jsonc`, `docs/openapi.yaml`, `docs/competitor-analysis.md`, `examples/`
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `tsconfig.test.json`, `src/startup-error.ts`, `src/openai/errors.ts`, `src/openai/types.ts`, `test/helpers/temp-dir.ts`, `test/unit/errors.test.ts`

**Interfaces:**
- Produces:
  - `class StartupError extends Error` in `src/startup-error.ts`.
  - `type ErrorCode`, `class AdapterError(status: number, code: ErrorCode, message: string, detail?: string)` with readonly `status`, `code`, `detail`, and `errorBody(error: AdapterError): { error: { message: string; type: ErrorCode; code: ErrorCode } }` in `src/openai/errors.ts`.
  - `ChatRole`, `ChatContentPart`, `ChatToolCall`, `ChatMessage`, `ChatTool`, `ToolChoice`, `ResponseFormat`, `ChatRequest` in `src/openai/types.ts`.
  - `makeTempDir(): Promise<{ path: string; cleanup(): Promise<void> }>` in `test/helpers/temp-dir.ts`. The path is a real path, with no symbolic links (important on macOS, where the temp folder is under the `/var` link).

- [ ] **Step 1: Delete the old files**

```bash
git rm -r -q src deploy examples Dockerfile docker-compose.yml .dockerignore opencode.jsonc docs/openapi.yaml docs/competitor-analysis.md scripts/edge-test.mjs scripts/full-test.mjs scripts/model-matrix-test.mjs scripts/sync-catalog-check.mjs
```

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "cursor2openai",
  "version": "1.0.0-alpha.0",
  "description": "OpenAI-compatible Chat Completions adapter that lets Hermes Agent use a Cursor subscription",
  "type": "module",
  "license": "MIT",
  "bin": {
    "cursor2openai": "./dist/cli.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.test.json",
    "test": "node --import tsx --test \"test/unit/**/*.test.ts\" \"test/integration/**/*.test.ts\"",
    "test:perf": "node --import tsx --test \"test/performance/**/*.test.ts\"",
    "start": "node dist/cli.js"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "yaml": "^2.9.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.7",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3"
  }
}
```

- [ ] **Step 3: Update TypeScript configuration**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "declaration": false,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Append to `.gitignore`:

```text
*.tmp
```

- [ ] **Step 4: Install dependencies**

Run: `rm -f package-lock.json && npm install`
Expected: install succeeds.

Run: `npm audit`
Expected: `found 0 vulnerabilities`

- [ ] **Step 5: Write the failing test**

`test/unit/errors.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { AdapterError, errorBody } from "../../src/openai/errors.js"

test("errorBody uses the OpenAI error shape", () => {
  const error = new AdapterError(404, "model_not_found", "Unknown model: x", "raw agent output")
  assert.deepEqual(errorBody(error), {
    error: { message: "Unknown model: x", type: "model_not_found", code: "model_not_found" },
  })
  assert.equal(error.status, 404)
  assert.equal(error.detail, "raw agent output")
  assert.ok(!JSON.stringify(errorBody(error)).includes("raw agent output"))
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test`
Expected: FAIL with an error that `src/openai/errors.js` cannot be found.

- [ ] **Step 7: Write the shared files**

`src/startup-error.ts`:

```typescript
export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartupError"
  }
}
```

`src/openai/errors.ts`:

```typescript
export type ErrorCode =
  | "invalid_request_error"
  | "invalid_api_key"
  | "model_not_found"
  | "not_found"
  | "method_not_allowed"
  | "request_too_large"
  | "rate_limit_exceeded"
  | "insufficient_quota"
  | "context_length_exceeded"
  | "server_busy"
  | "service_unavailable"
  | "timeout"
  | "upstream_error"
  | "internal_error"

export class AdapterError extends Error {
  readonly status: number
  readonly code: ErrorCode
  // Never sent to clients: may contain prompt text from agent output.
  readonly detail?: string

  constructor(status: number, code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = "AdapterError"
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export const errorBody = (error: AdapterError) => ({
  error: { message: error.message, type: error.code, code: error.code },
})
```

`src/openai/types.ts`:

```typescript
export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool"

export type ChatContentPart = {
  type: string
  text?: string
  image_url?: { url: string; detail?: string } | string
  [key: string]: unknown
}

export type ChatToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export type ChatMessage = {
  role: ChatRole
  content?: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  [key: string]: unknown
}

export type ChatTool = {
  type: "function"
  function: { name: string; description?: string; parameters?: unknown }
}

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } }

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema?: { name?: string; schema?: unknown; strict?: boolean } }

export type ChatRequest = {
  model?: unknown
  messages?: unknown
  stream?: unknown
  stream_options?: unknown
  tools?: unknown
  tool_choice?: unknown
  parallel_tool_calls?: unknown
  response_format?: unknown
  n?: unknown
  [key: string]: unknown
}
```

`test/helpers/temp-dir.ts`:

```typescript
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const makeTempDir = async (): Promise<{ path: string; cleanup(): Promise<void> }> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "c2o-test-")))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}
```

- [ ] **Step 8: Run tests, type check, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 1 test passes; type check and build succeed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: remove Plan2API code and set up cursor2openai skeleton"
```

---

### Task 3: Configuration

**Files:**
- Create: `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: `StartupError` (Task 2).
- Produces:
  - `type Config = { apiKey: string; host: string; port: number; tlsCertFile?: string; tlsKeyFile?: string; allowInsecureHttp: boolean; dataDir: string; workspaceDir: string; defaultModel: string; agentBin: string; requestTimeoutMs: number; maxConcurrent: number; maxQueued: number; queueTimeoutMs: number; conversationTtlMs: number; maxConversations: number; modelCacheMs: number; maxBodyBytes: number; debugLogAgentOutput: boolean }`
  - `loadConfig(input: { env: NodeJS.ProcessEnv; home: string; platform: NodeJS.Platform; readFile?: (path: string) => string | undefined }): Config` (throws `StartupError`)
  - `isLoopback(host: string): boolean`
  - `defaultWorkspaceDir(platform: NodeJS.Platform): string`

- [ ] **Step 1: Write the failing tests**

`test/unit/config.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { isLoopback, loadConfig } from "../../src/config.js"

const KEY = "k".repeat(32)
const load = (env: Record<string, string>, options: { platform?: NodeJS.Platform; file?: string } = {}) =>
  loadConfig({ env, home: "/home/tester", platform: options.platform ?? "linux", readFile: () => options.file })

test("requires an API key of at least 32 characters", () => {
  assert.throws(() => load({}), /CURSOR2OPENAI_API_KEY: is required/)
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: "short" }), /CURSOR2OPENAI_API_KEY: must be at least 32 characters/)
})

test("applies the spec defaults", () => {
  const config = load({ CURSOR2OPENAI_API_KEY: KEY })
  assert.deepEqual(config, {
    apiKey: KEY,
    host: "127.0.0.1",
    port: 8787,
    tlsCertFile: undefined,
    tlsKeyFile: undefined,
    allowInsecureHttp: false,
    dataDir: "/home/tester/.cursor2openai",
    workspaceDir: "/var/lib/cursor2openai",
    defaultModel: "composer-2.5",
    agentBin: "agent",
    requestTimeoutMs: 600_000,
    maxConcurrent: 4,
    maxQueued: 16,
    queueTimeoutMs: 60_000,
    conversationTtlMs: 30 * 86_400_000,
    maxConversations: 10_000,
    modelCacheMs: 300_000,
    maxBodyBytes: 20_971_520,
    debugLogAgentOutput: false,
  })
})

test("uses the macOS workspace default on darwin", () => {
  assert.equal(load({ CURSOR2OPENAI_API_KEY: KEY }, { platform: "darwin" }).workspaceDir, "/Users/Shared/cursor2openai")
})

test("environment variables override the config file", () => {
  const config = load(
    { CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_PORT: "9100" },
    { file: "port: 9000\ndefault_model: gpt-5.6-sol-high\ndebug_log_agent_output: true\n" },
  )
  assert.equal(config.port, 9100)
  assert.equal(config.defaultModel, "gpt-5.6-sol-high")
  assert.equal(config.debugLogAgentOutput, true)
})

test("rejects unknown config file settings and invalid YAML", () => {
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: KEY }, { file: "colour: blue\n" }), /unknown setting: colour/)
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: KEY }, { file: "port: [\n" }), /not valid YAML/)
})

test("a non-loopback address requires HTTPS or an explicit insecure opt-in", () => {
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_HOST: "0.0.0.0" }), /requires HTTPS/)
  assert.equal(load({ CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_HOST: "0.0.0.0", CURSOR2OPENAI_ALLOW_INSECURE_HTTP: "true" }).allowInsecureHttp, true)
  const tls = load({
    CURSOR2OPENAI_API_KEY: KEY,
    CURSOR2OPENAI_HOST: "192.168.1.10",
    CURSOR2OPENAI_TLS_CERT_FILE: "/certs/cert.pem",
    CURSOR2OPENAI_TLS_KEY_FILE: "/certs/key.pem",
  })
  assert.equal(tls.tlsCertFile, "/certs/cert.pem")
})

test("TLS files must be set together", () => {
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_TLS_CERT_FILE: "/certs/cert.pem" }), /both/)
})

test("the workspace folder must be an absolute path, and ~ is expanded", () => {
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_WORKSPACE_DIR: "relative/dir" }), /absolute path/)
  assert.equal(load({ CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_WORKSPACE_DIR: "~/ws" }).workspaceDir, "/home/tester/ws")
})

test("rejects invalid numbers", () => {
  assert.throws(() => load({ CURSOR2OPENAI_API_KEY: KEY, CURSOR2OPENAI_PORT: "http" }), /CURSOR2OPENAI_PORT/)
})

test("isLoopback recognizes only loopback names", () => {
  assert.equal(isLoopback("127.0.0.1"), true)
  assert.equal(isLoopback("::1"), true)
  assert.equal(isLoopback("LOCALHOST"), true)
  assert.equal(isLoopback("0.0.0.0"), false)
  assert.equal(isLoopback("192.168.1.10"), false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/config.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/config.ts`:

```typescript
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { StartupError } from "./startup-error.js"

export type Config = {
  apiKey: string
  host: string
  port: number
  tlsCertFile?: string
  tlsKeyFile?: string
  allowInsecureHttp: boolean
  dataDir: string
  workspaceDir: string
  defaultModel: string
  agentBin: string
  requestTimeoutMs: number
  maxConcurrent: number
  maxQueued: number
  queueTimeoutMs: number
  conversationTtlMs: number
  maxConversations: number
  modelCacheMs: number
  maxBodyBytes: number
  debugLogAgentOutput: boolean
}

export type LoadConfigInput = {
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  readFile?: (path: string) => string | undefined
}

const ENV_TO_FIELD = {
  API_KEY: "apiKey",
  HOST: "host",
  PORT: "port",
  TLS_CERT_FILE: "tlsCertFile",
  TLS_KEY_FILE: "tlsKeyFile",
  ALLOW_INSECURE_HTTP: "allowInsecureHttp",
  WORKSPACE_DIR: "workspaceDir",
  DEFAULT_MODEL: "defaultModel",
  AGENT_BIN: "agentBin",
  REQUEST_TIMEOUT_MS: "requestTimeoutMs",
  MAX_CONCURRENT: "maxConcurrent",
  MAX_QUEUED: "maxQueued",
  QUEUE_TIMEOUT_MS: "queueTimeoutMs",
  CONVERSATION_TTL_DAYS: "conversationTtlDays",
  MAX_CONVERSATIONS: "maxConversations",
  MODEL_CACHE_MS: "modelCacheMs",
  MAX_BODY_BYTES: "maxBodyBytes",
  DEBUG_LOG_AGENT_OUTPUT: "debugLogAgentOutput",
} as const

type EnvName = keyof typeof ENV_TO_FIELD

const FIELD_TO_ENV = Object.fromEntries(Object.entries(ENV_TO_FIELD).map(([env, field]) => [field, env])) as Record<string, EnvName>

const boolean = z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
const integer = (min: number) => z.coerce.number().int().min(min)

const schema = z.object({
  apiKey: z.string({ required_error: "is required" }).min(32, "must be at least 32 characters"),
  host: z.string().min(1).default("127.0.0.1"),
  port: integer(1).max(65_535).default(8787),
  tlsCertFile: z.string().min(1).optional(),
  tlsKeyFile: z.string().min(1).optional(),
  allowInsecureHttp: boolean.default(false),
  workspaceDir: z.string().min(1),
  defaultModel: z.string().min(1).default("composer-2.5"),
  agentBin: z.string().min(1).default("agent"),
  requestTimeoutMs: integer(1).default(600_000),
  maxConcurrent: integer(1).default(4),
  maxQueued: integer(0).default(16),
  queueTimeoutMs: integer(1).default(60_000),
  conversationTtlDays: integer(1).default(30),
  maxConversations: integer(1).default(10_000),
  modelCacheMs: integer(1).default(300_000),
  maxBodyBytes: integer(1).default(20_971_520),
  debugLogAgentOutput: boolean.default(false),
})

export const isLoopback = (host: string): boolean => ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase())

export const defaultWorkspaceDir = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "/Users/Shared/cursor2openai" : "/var/lib/cursor2openai"

const expandHome = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path

const defaultReadFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new StartupError(`Cannot read ${path}: ${(error as Error).message}`)
  }
}

const fileValues = (text: string | undefined, path: string): Record<string, unknown> => {
  if (text === undefined) return {}
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    throw new StartupError(`${path} is not valid YAML: ${(error as Error).message}`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new StartupError(`${path} must contain a YAML mapping`)
  const values: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const field = ENV_TO_FIELD[key.toUpperCase() as EnvName]
    if (!field) throw new StartupError(`${path} has an unknown setting: ${key}`)
    values[field] = value
  }
  return values
}

export const loadConfig = (input: LoadConfigInput): Config => {
  const dataDir = expandHome(input.env.CURSOR2OPENAI_DATA_DIR ?? join(input.home, ".cursor2openai"), input.home)
  const configPath = join(dataDir, "config.yaml")
  const values: Record<string, unknown> = {
    workspaceDir: defaultWorkspaceDir(input.platform),
    ...fileValues((input.readFile ?? defaultReadFile)(configPath), configPath),
  }
  for (const [name, field] of Object.entries(ENV_TO_FIELD)) {
    const value = input.env[`CURSOR2OPENAI_${name}`]
    if (value !== undefined && value !== "") values[field] = value
  }

  const parsed = schema.safeParse(values)
  if (!parsed.success) {
    throw new StartupError(
      parsed.error.issues.map((issue) => `CURSOR2OPENAI_${FIELD_TO_ENV[String(issue.path[0])] ?? issue.path.join(".")}: ${issue.message}`).join("; "),
    )
  }
  const settings = parsed.data
  const workspaceDir = expandHome(settings.workspaceDir, input.home)
  const tlsCertFile = settings.tlsCertFile && expandHome(settings.tlsCertFile, input.home)
  const tlsKeyFile = settings.tlsKeyFile && expandHome(settings.tlsKeyFile, input.home)

  if (!isAbsolute(workspaceDir)) throw new StartupError("CURSOR2OPENAI_WORKSPACE_DIR must be an absolute path")
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new StartupError("Set both CURSOR2OPENAI_TLS_CERT_FILE and CURSOR2OPENAI_TLS_KEY_FILE, or neither")
  }
  if (!isLoopback(settings.host) && !tlsCertFile && !settings.allowInsecureHttp) {
    throw new StartupError(
      `Listening on ${settings.host} requires HTTPS. Set CURSOR2OPENAI_TLS_CERT_FILE and CURSOR2OPENAI_TLS_KEY_FILE, or set CURSOR2OPENAI_ALLOW_INSECURE_HTTP=true to allow unencrypted HTTP`,
    )
  }

  return {
    apiKey: settings.apiKey,
    host: settings.host,
    port: settings.port,
    tlsCertFile,
    tlsKeyFile,
    allowInsecureHttp: settings.allowInsecureHttp,
    dataDir,
    workspaceDir,
    defaultModel: settings.defaultModel,
    agentBin: settings.agentBin,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxConcurrent: settings.maxConcurrent,
    maxQueued: settings.maxQueued,
    queueTimeoutMs: settings.queueTimeoutMs,
    conversationTtlMs: settings.conversationTtlDays * 86_400_000,
    maxConversations: settings.maxConversations,
    modelCacheMs: settings.modelCacheMs,
    maxBodyBytes: settings.maxBodyBytes,
    debugLogAgentOutput: settings.debugLogAgentOutput,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "feat: load and validate adapter configuration"
```

---

### Task 4: Conversation key

**Files:**
- Create: `src/conversation/fingerprint.ts`
- Test: `test/unit/fingerprint.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ChatTool`, `ResponseFormat`, `ToolChoice` (Task 2).
- Produces:
  - `type Controls = { toolChoice: ToolChoice; parallelToolCalls: boolean; responseFormat: ResponseFormat }`
  - `type KeyInput = { affinity: string; model: string; tools: ChatTool[]; controls: Controls; messages: ChatMessage[] }`
  - `canonicalJson(value: unknown): string`
  - `canonicalMessage(message: ChatMessage): Record<string, unknown>`
  - `conversationKey(input: KeyInput): string` (64 hex characters)
  - `lastAssistantIndex(messages: ChatMessage[]): number` (`-1` when there is none)

- [ ] **Step 1: Write the failing tests**

`test/unit/fingerprint.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { canonicalJson, conversationKey, lastAssistantIndex, type KeyInput } from "../../src/conversation/fingerprint.js"
import type { ChatMessage } from "../../src/openai/types.js"

const PNG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const base = (messages: ChatMessage[], overrides: Partial<KeyInput> = {}): KeyInput => ({
  affinity: "conv-1",
  model: "composer-2.5",
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  controls: { toolChoice: "auto", parallelToolCalls: true, responseFormat: { type: "text" } },
  messages,
  ...overrides,
})
const system: ChatMessage = { role: "system", content: "You are Hermes." }
const user: ChatMessage = { role: "user", content: "Read notes.md" }
const call = { id: "call_abc", type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"notes.md\"}" } }

test("canonicalJson sorts keys and drops undefined values", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, null] } }), "{\"a\":{\"c\":[2,null]},\"b\":1}")
})

test("null and empty assistant content produce the same key", () => {
  const withNull = conversationKey(base([system, user, { role: "assistant", content: null, tool_calls: [call] }]))
  const withEmpty = conversationKey(base([system, user, { role: "assistant", content: "", tool_calls: [call] }]))
  assert.equal(withNull, withEmpty)
})

test("assistant text is compared without surrounding whitespace, user text exactly", () => {
  assert.equal(
    conversationKey(base([user, { role: "assistant", content: "Done.\n" }])),
    conversationKey(base([user, { role: "assistant", content: "Done." }])),
  )
  assert.notEqual(conversationKey(base([{ role: "user", content: "hi " }])), conversationKey(base([{ role: "user", content: "hi" }])))
})

test("images are hashed, and different images give different keys", () => {
  const key = (url: string) => conversationKey(base([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url } }] }]))
  assert.notEqual(key(PNG_A), key(PNG_B))
  assert.equal(key(PNG_A), key(PNG_A))
})

test("tool-call IDs and tool_call_id are part of the key", () => {
  const other = { ...call, id: "call_other" }
  assert.notEqual(
    conversationKey(base([user, { role: "assistant", content: "", tool_calls: [call] }])),
    conversationKey(base([user, { role: "assistant", content: "", tool_calls: [other] }])),
  )
  assert.notEqual(
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "a" }])),
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "b" }])),
  )
})

test("fields outside the canonical form are ignored", () => {
  assert.equal(
    conversationKey(base([user, { role: "assistant", content: "ok", reasoning: "thinking", reasoning_content: "t", reasoning_details: [] }])),
    conversationKey(base([user, { role: "assistant", content: "ok" }])),
  )
  assert.equal(
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "a", name: "read_file" }])),
    conversationKey(base([{ role: "tool", content: "x", tool_call_id: "a" }])),
  )
})

test("affinity, model, tools, tool order, and each control change the key", () => {
  const messages = [system, user]
  const reference = conversationKey(base(messages))
  const extraTool = { type: "function" as const, function: { name: "write_file" } }
  const variants: Partial<KeyInput>[] = [
    { affinity: "conv-2" },
    { model: "composer-2.5-fast" },
    { tools: [] },
    { tools: [extraTool, ...base(messages).tools] },
    { tools: [...base(messages).tools, extraTool] },
    { controls: { toolChoice: "none", parallelToolCalls: true, responseFormat: { type: "text" } } },
    { controls: { toolChoice: "auto", parallelToolCalls: false, responseFormat: { type: "text" } } },
    { controls: { toolChoice: "auto", parallelToolCalls: true, responseFormat: { type: "json_object" } } },
  ]
  const keys = variants.map((overrides) => conversationKey(base(messages, overrides)))
  for (const key of keys) assert.notEqual(key, reference)
  assert.notEqual(keys[3], keys[4])
})

test("system and developer roles stay distinct", () => {
  assert.notEqual(
    conversationKey(base([{ role: "system", content: "x" }])),
    conversationKey(base([{ role: "developer", content: "x" }])),
  )
})

test("a recorded tool-call reply matches the next Hermes request (probe shape)", () => {
  const first: ChatMessage[] = [system, user]
  const adapterReply: ChatMessage = { role: "assistant", content: "", tool_calls: [call] }
  const recordedKey = conversationKey(base([...first, adapterReply]))

  const hermesReplay: ChatMessage = { role: "assistant", content: "", tool_calls: [call] }
  const toolResult: ChatMessage = { role: "tool", content: "file contents", tool_call_id: "call_abc" }
  const next = [...first, hermesReplay, toolResult]
  const index = lastAssistantIndex(next)
  assert.equal(index, 2)
  assert.equal(conversationKey(base(next.slice(0, index + 1))), recordedKey)
})

test("lastAssistantIndex returns -1 without assistant messages", () => {
  assert.equal(lastAssistantIndex([system, user]), -1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/conversation/fingerprint.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/conversation/fingerprint.ts`:

```typescript
import { createHash } from "node:crypto"
import type { ChatMessage, ChatTool, ResponseFormat, ToolChoice } from "../openai/types.js"

export type Controls = { toolChoice: ToolChoice; parallelToolCalls: boolean; responseFormat: ResponseFormat }

export type KeyInput = {
  affinity: string
  model: string
  tools: ChatTool[]
  controls: Controls
  messages: ChatMessage[]
}

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

const canonicalContent = (message: ChatMessage): unknown => {
  const { content } = message
  if (content === null || content === undefined) return ""
  // Hermes stores assistant text stripped of surrounding whitespace before replaying it.
  if (typeof content === "string") return message.role === "assistant" ? content.trim() : content
  return content.map((part) => {
    if (part.type !== "image_url") return part
    const url = typeof part.image_url === "string" ? part.image_url : (part.image_url?.url ?? "")
    return { type: "image_url", sha256: sha256(url) }
  })
}

export const canonicalMessage = (message: ChatMessage): Record<string, unknown> => {
  const canonical: Record<string, unknown> = { role: message.role, content: canonicalContent(message) }
  if (message.tool_calls?.length) {
    canonical.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: call.type,
      function: { name: call.function.name, arguments: call.function.arguments },
    }))
  }
  if (typeof message.tool_call_id === "string") canonical.tool_call_id = message.tool_call_id
  return canonical
}

export const conversationKey = (input: KeyInput): string =>
  sha256(
    canonicalJson({
      affinity: input.affinity,
      model: input.model,
      tools: input.tools,
      controls: input.controls,
      messages: input.messages.map(canonicalMessage),
    }),
  )

export const lastAssistantIndex = (messages: ChatMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return index
  }
  return -1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/conversation/fingerprint.ts test/unit/fingerprint.test.ts
git commit -m "feat: compute exact conversation keys"
```

---

### Task 5: Conversation index

**Files:**
- Create: `src/conversation/conversation-index.ts`
- Test: `test/unit/conversation-index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type IndexEntry = { sessionId: string; marker: string; lastUsedAt: number }`
  - `type IndexOptions = { filePath: string; ttlMs: number; maxEntries: number; batchDelayMs?: number; now?: () => number; onWarning?: (message: string) => void }`
  - `class ConversationIndex` with `static open(options: IndexOptions): Promise<ConversationIndex>`, `take(key: string): Promise<IndexEntry | undefined>` (removes the entry and resolves only after a save containing the removal has completed), `add(key: string, value: { sessionId: string; marker: string }): void`, `prune(): void`, `size(): number`, `flush(): Promise<void>`, `close(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/unit/conversation-index.test.ts`:

```typescript
import assert from "node:assert/strict"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { ConversationIndex } from "../../src/conversation/conversation-index.js"
import { makeTempDir } from "../helpers/temp-dir.js"

let dir: { path: string; cleanup(): Promise<void> }
let file: string
const DAY = 86_400_000
const open = (options: { now?: () => number; maxEntries?: number; onWarning?: (message: string) => void } = {}) =>
  ConversationIndex.open({ filePath: file, ttlMs: 30 * DAY, maxEntries: options.maxEntries ?? 100, batchDelayMs: 5, ...options })

beforeEach(async () => {
  dir = await makeTempDir()
  file = join(dir.path, "conversations.json")
})
afterEach(() => dir.cleanup())

test("take removes an entry and the removal is on disk before take resolves", async () => {
  const index = await open()
  index.add("k1", { sessionId: "s1", marker: "TOOL_CALLS_aaaaaaaa" })
  await index.flush()
  const entry = await index.take("k1")
  assert.equal(entry?.sessionId, "s1")
  assert.equal(await index.take("k1"), undefined)
  const reopened = await open()
  assert.equal(reopened.size(), 0)
  await index.close()
  await reopened.close()
})

test("added entries survive a restart", async () => {
  const index = await open()
  index.add("k1", { sessionId: "s1", marker: "TOOL_CALLS_aaaaaaaa" })
  await index.close()
  const reopened = await open()
  assert.deepEqual((await reopened.take("k1"))?.marker, "TOOL_CALLS_aaaaaaaa")
  await reopened.close()
})

test("interleaved adds and takes leave the file equal to memory", async () => {
  const index = await open()
  const work: Promise<unknown>[] = []
  for (let i = 0; i < 50; i += 1) {
    index.add(`k${i}`, { sessionId: `s${i}`, marker: "TOOL_CALLS_aaaaaaaa" })
    if (i % 3 === 0) work.push(index.take(`k${i}`))
  }
  await Promise.all(work)
  await index.flush()
  const saved = JSON.parse(await readFile(file, "utf8")) as { entries: Record<string, unknown> }
  assert.equal(Object.keys(saved.entries).length, index.size())
  assert.equal(saved.entries.k0, undefined)
  assert.ok(saved.entries.k1)
  await index.close()
})

test("entries older than the expiry are removed when the index opens", async () => {
  let now = 1_000 * DAY
  const index = await open({ now: () => now })
  index.add("old", { sessionId: "s1", marker: "TOOL_CALLS_aaaaaaaa" })
  await index.close()
  now += 31 * DAY
  const reopened = await open({ now: () => now })
  assert.equal(reopened.size(), 0)
  await reopened.close()
})

test("the least recently used entries are removed above the cap", async () => {
  const index = await open({ maxEntries: 2 })
  index.add("a", { sessionId: "s1", marker: "m" })
  index.add("b", { sessionId: "s2", marker: "m" })
  index.add("c", { sessionId: "s3", marker: "m" })
  assert.equal(index.size(), 2)
  assert.equal(await index.take("a"), undefined)
  await index.close()
})

test("a corrupt file produces a warning and an empty index", async () => {
  await writeFile(file, "{not json")
  const warnings: string[] = []
  const index = await open({ onWarning: (message) => warnings.push(message) })
  assert.equal(index.size(), 0)
  assert.equal(warnings.length, 1)
  await index.close()
})

test("the index file is readable only by its owner", async () => {
  const index = await open()
  index.add("k1", { sessionId: "s1", marker: "m" })
  await index.close()
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/conversation/conversation-index.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/conversation/conversation-index.ts`:

```typescript
import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname } from "node:path"

export type IndexEntry = { sessionId: string; marker: string; lastUsedAt: number }

export type IndexOptions = {
  filePath: string
  ttlMs: number
  maxEntries: number
  batchDelayMs?: number
  now?: () => number
  onWarning?: (message: string) => void
}

type IndexFile = { version: 1; entries: Record<string, IndexEntry> }

const isEntry = (value: unknown): value is IndexEntry => {
  const entry = value as IndexEntry
  return typeof entry?.sessionId === "string" && typeof entry.marker === "string" && typeof entry.lastUsedAt === "number"
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r").catch(() => undefined)
  if (!handle) return
  try {
    await handle.sync()
  } catch (error) {
    // Some platforms and file systems cannot fsync a directory.
    const code = (error as NodeJS.ErrnoException).code ?? ""
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(code)) throw error
  } finally {
    await handle.close()
  }
}

export class ConversationIndex {
  private readonly entries = new Map<string, IndexEntry>()
  private writeChain: Promise<void> = Promise.resolve()
  private batchTimer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined
  private readonly now: () => number

  private constructor(private readonly options: IndexOptions) {
    this.now = options.now ?? Date.now
  }

  static async open(options: IndexOptions): Promise<ConversationIndex> {
    const index = new ConversationIndex(options)
    await index.load()
    index.prune()
    index.pruneTimer = setInterval(() => index.prune(), 3_600_000)
    index.pruneTimer.unref()
    return index
  }

  async take(key: string): Promise<IndexEntry | undefined> {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    await this.save()
    return entry
  }

  add(key: string, value: { sessionId: string; marker: string }): void {
    this.entries.delete(key)
    this.entries.set(key, { ...value, lastUsedAt: this.now() })
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.scheduleBatch()
  }

  prune(): void {
    const cutoff = this.now() - this.options.ttlMs
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.scheduleBatch()
  }

  size(): number {
    return this.entries.size
  }

  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    await this.save()
  }

  async close(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    await this.flush()
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.options.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.onWarning?.(`Could not read the conversation index: ${(error as Error).message}`)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw) as IndexFile
      const loaded = Object.entries(parsed.entries ?? {}).filter((pair): pair is [string, IndexEntry] => isEntry(pair[1]))
      loaded.sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
      for (const [key, entry] of loaded) this.entries.set(key, entry)
    } catch {
      this.options.onWarning?.("The conversation index is unreadable; starting with an empty index")
    }
  }

  private scheduleBatch(): void {
    if (this.batchTimer) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.save().catch((error: unknown) => this.options.onWarning?.(`Could not save the conversation index: ${(error as Error).message}`))
    }, this.options.batchDelayMs ?? 1000)
    this.batchTimer.unref()
  }

  // Saves run one at a time, and each writes the state at the moment it runs, so an older save never overwrites a newer one.
  private save(): Promise<void> {
    const run = this.writeChain.then(() => this.writeSnapshot())
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async writeSnapshot(): Promise<void> {
    const target = this.options.filePath
    const temp = `${target}.${process.pid}.tmp`
    const data: IndexFile = { version: 1, entries: Object.fromEntries(this.entries) }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const handle = await open(temp, "w", 0o600)
    try {
      await handle.writeFile(JSON.stringify(data))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, target)
    await syncDirectory(dirname(target))
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/conversation/conversation-index.ts test/unit/conversation-index.test.ts
git commit -m "feat: add durable one-time-use conversation index"
```

---

### Task 6: Tool protocol

**Files:**
- Create: `src/prompt/tool-protocol.ts`
- Test: `test/unit/tool-protocol.test.ts`

**Interfaces:**
- Consumes: `ChatTool`, `ToolChoice` (Task 2).
- Produces:
  - `MAX_BLOCK_BYTES = 1_048_576`
  - `type ParsedToolCall = { name: string; arguments: string }`
  - `type BlockParseResult = { ok: true; calls: ParsedToolCall[] } | { ok: false; retryable: boolean; reason: string }` (`retryable` is true only when the text is not valid JSON yet, so a later closing marker may still complete it)
  - `createMarker(): string` (for example `TOOL_CALLS_7f3a9c2e`), `openingLine(marker: string): string`, `closingLine(marker: string): string`
  - `toolInstructions(input: { marker: string; tools: ChatTool[]; toolChoice: ToolChoice; parallelToolCalls: boolean }): string`
  - `toolReminder(input: { marker: string; toolChoice: ToolChoice; parallelToolCalls: boolean }): string`
  - `parseToolBlock(body: string): BlockParseResult`

- [ ] **Step 1: Write the failing tests**

`test/unit/tool-protocol.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  closingLine,
  createMarker,
  MAX_BLOCK_BYTES,
  openingLine,
  parseToolBlock,
  toolInstructions,
  toolReminder,
} from "../../src/prompt/tool-protocol.js"
import type { ChatTool } from "../../src/openai/types.js"

const tools: ChatTool[] = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
]

test("markers are random and use the expected format", () => {
  const marker = createMarker()
  assert.match(marker, /^TOOL_CALLS_[0-9a-f]{8}$/)
  assert.notEqual(createMarker(), marker)
  assert.equal(openingLine("TOOL_CALLS_x"), "<TOOL_CALLS_x>")
  assert.equal(closingLine("TOOL_CALLS_x"), "</TOOL_CALLS_x>")
})

test("instructions describe the block format, the rules, and every tool", () => {
  const text = toolInstructions({ marker: "TOOL_CALLS_abcdef01", tools, toolChoice: "auto", parallelToolCalls: true })
  assert.ok(text.includes("\n<TOOL_CALLS_abcdef01>\n"))
  assert.ok(text.includes("\n</TOOL_CALLS_abcdef01>\n"))
  assert.ok(text.includes("at most one block"))
  assert.ok(text.includes("read_file: Read a file"))
  assert.ok(text.includes("\"path\":{\"type\":\"string\"}"))
  assert.ok(text.includes("several tools"))
})

test("instructions follow parallel_tool_calls and tool_choice", () => {
  const single = toolInstructions({ marker: "M", tools, toolChoice: "required", parallelToolCalls: false })
  assert.ok(single.includes("exactly one tool"))
  assert.ok(single.includes("must request at least one tool"))
  const named = toolInstructions({ marker: "M", tools, toolChoice: { type: "function", function: { name: "read_file" } }, parallelToolCalls: true })
  assert.ok(named.includes("must request the tool named read_file"))
})

test("the reminder repeats the marker without the tool list", () => {
  const text = toolReminder({ marker: "TOOL_CALLS_abcdef01", toolChoice: "auto", parallelToolCalls: false })
  assert.ok(text.includes("<TOOL_CALLS_abcdef01>"))
  assert.ok(text.includes("exactly one tool"))
  assert.ok(!text.includes("read_file"))
})

test("parses calls and always produces string arguments", () => {
  const result = parseToolBlock('[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":"{\\"y\\":2}"},{"name":"c"}]')
  assert.deepEqual(result, {
    ok: true,
    calls: [
      { name: "a", arguments: "{\"x\":1}" },
      { name: "b", arguments: "{\"y\":2}" },
      { name: "c", arguments: "{}" },
    ],
  })
})

test("arguments with newlines, Unicode, and marker text are preserved", () => {
  const args = { text: "line 1\nline 2 é 😀 </TOOL_CALLS_abcdef01>" }
  const result = parseToolBlock(JSON.stringify([{ name: "echo", arguments: args }]))
  assert.ok(result.ok)
  assert.deepEqual(JSON.parse(result.calls[0].arguments), args)
})

test("reports invalid blocks, and marks only incomplete JSON as retryable", () => {
  assert.deepEqual(parseToolBlock('[{"name":"a",'), { ok: false, retryable: true, reason: "not valid JSON" })
  const cases: Array<[string, string]> = [
    ['{"name":"a"}', "not a JSON array"],
    ["[]", "no tool calls"],
    ["[1]", "item is not an object"],
    ['[{"arguments":{}}]', "item has no name"],
    ['[{"name":" "}]', "item has no name"],
    ['[{"name":"a","arguments":5}]', "arguments must be an object or a string"],
  ]
  for (const [body, reason] of cases) assert.deepEqual(parseToolBlock(body), { ok: false, retryable: false, reason })
})

test("rejects blocks larger than 1 MB", () => {
  const body = JSON.stringify([{ name: "a", arguments: { text: "x".repeat(MAX_BLOCK_BYTES) } }])
  assert.deepEqual(parseToolBlock(body), { ok: false, retryable: false, reason: "block too large" })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/prompt/tool-protocol.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/prompt/tool-protocol.ts`:

```typescript
import { randomBytes } from "node:crypto"
import type { ChatTool, ToolChoice } from "../openai/types.js"

export const MAX_BLOCK_BYTES = 1_048_576

export type ParsedToolCall = { name: string; arguments: string }

export type BlockParseResult =
  | { ok: true; calls: ParsedToolCall[] }
  | { ok: false; retryable: boolean; reason: string }

export const createMarker = (): string => `TOOL_CALLS_${randomBytes(4).toString("hex")}`
export const openingLine = (marker: string): string => `<${marker}>`
export const closingLine = (marker: string): string => `</${marker}>`

const choiceRule = (toolChoice: ToolChoice): string => {
  if (toolChoice === "required") return "You must request at least one tool in this reply."
  if (typeof toolChoice === "object") return `You must request the tool named ${toolChoice.function.name} in this reply.`
  return "Request a tool only when you need one. Otherwise answer normally, without a block."
}

export const toolInstructions = (input: {
  marker: string
  tools: ChatTool[]
  toolChoice: ToolChoice
  parallelToolCalls: boolean
}): string =>
  [
    "You are the model behind an OpenAI-compatible chat API. The client application runs every tool on the user's machine.",
    "Do not use tools of your own, except reading image files you are explicitly asked to view.",
    "To request tools, write one block in exactly this format, with each marker alone on its own line:",
    openingLine(input.marker),
    '[{"name": "<tool name>", "arguments": {<arguments as a JSON object>}}]',
    closingLine(input.marker),
    "Rules:",
    "- Normal text may come before the block.",
    "- Write at most one block per reply.",
    input.parallelToolCalls ? "- The block may request several tools." : "- The block must request exactly one tool.",
    "- Stop writing immediately after the closing marker.",
    "- Use only tool names from the list below.",
    `- ${choiceRule(input.toolChoice)}`,
    "",
    "Available tools:",
    ...input.tools.map(
      (tool) => `- ${tool.function.name}: ${tool.function.description ?? ""}\n  parameters: ${JSON.stringify(tool.function.parameters ?? {})}`,
    ),
  ].join("\n")

export const toolReminder = (input: { marker: string; toolChoice: ToolChoice; parallelToolCalls: boolean }): string =>
  `(Reminder: request tools only with one ${openingLine(input.marker)} ... ${closingLine(input.marker)} block, each marker alone on its own line${
    input.parallelToolCalls ? "" : ", exactly one tool"
  }. ${choiceRule(input.toolChoice)})`

export const parseToolBlock = (body: string): BlockParseResult => {
  if (Buffer.byteLength(body) > MAX_BLOCK_BYTES) return { ok: false, retryable: false, reason: "block too large" }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, retryable: true, reason: "not valid JSON" }
  }
  if (!Array.isArray(parsed)) return { ok: false, retryable: false, reason: "not a JSON array" }
  if (parsed.length === 0) return { ok: false, retryable: false, reason: "no tool calls" }
  const calls: ParsedToolCall[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, retryable: false, reason: "item is not an object" }
    const { name, arguments: args } = item as { name?: unknown; arguments?: unknown }
    if (typeof name !== "string" || !name.trim()) return { ok: false, retryable: false, reason: "item has no name" }
    if (args === undefined) calls.push({ name, arguments: "{}" })
    else if (typeof args === "string") calls.push({ name, arguments: args })
    else if (typeof args === "object" && args !== null && !Array.isArray(args)) calls.push({ name, arguments: JSON.stringify(args) })
    else return { ok: false, retryable: false, reason: "arguments must be an object or a string" }
  }
  return { ok: true, calls }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/prompt/tool-protocol.ts test/unit/tool-protocol.test.ts
git commit -m "feat: add random-marker tool protocol"
```

---

### Task 7: Stream splitter

**Files:**
- Create: `src/prompt/stream-splitter.ts`
- Test: `test/unit/stream-splitter.test.ts`

**Interfaces:**
- Consumes: `openingLine`, `closingLine`, `parseToolBlock`, `MAX_BLOCK_BYTES`, `ParsedToolCall` (Task 6).
- Produces:
  - `type SplitterEvent = { type: "text"; text: string } | { type: "tool_calls"; calls: ParsedToolCall[] }`
  - `type SplitterSummary = { droppedChars: number; invalidBlockReason?: string }`
  - `class StreamSplitter` with `constructor(marker: string | undefined)` (`undefined` passes all text through), `push(chunk: string): SplitterEvent[]`, `end(): { events: SplitterEvent[]; summary: SplitterSummary }`

- [ ] **Step 1: Write the failing tests**

`test/unit/stream-splitter.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { StreamSplitter, type SplitterEvent } from "../../src/prompt/stream-splitter.js"
import { MAX_BLOCK_BYTES } from "../../src/prompt/tool-protocol.js"

const M = "TOOL_CALLS_abcdef01"
const collect = (splitter: StreamSplitter, chunks: string[]) => {
  const events: SplitterEvent[] = []
  for (const chunk of chunks) events.push(...splitter.push(chunk))
  const end = splitter.end()
  events.push(...end.events)
  const text = events.filter((event) => event.type === "text").map((event) => event.text).join("")
  const calls = events.flatMap((event) => (event.type === "tool_calls" ? event.calls : []))
  return { events, text, calls, summary: end.summary }
}
const block = (json: string) => `<${M}>\n${json}\n</${M}>`

test("without a marker, all text passes through immediately", () => {
  const splitter = new StreamSplitter(undefined)
  assert.deepEqual(splitter.push(`<${M}>\n`), [{ type: "text", text: `<${M}>\n` }])
})

test("plain text is sent at once, except a line that could become the marker", () => {
  const splitter = new StreamSplitter(M)
  assert.deepEqual(splitter.push("Hello\nwor"), [{ type: "text", text: "Hello\nwor" }])
  assert.deepEqual(splitter.push("\n<TOOL"), [{ type: "text", text: "\n" }])
  assert.deepEqual(splitter.push("S are fun"), [{ type: "text", text: "<TOOLS are fun" }])
})

test("a valid block becomes tool calls, with text before it kept", () => {
  const result = collect(new StreamSplitter(M), [`Let me look.\n${block('[{"name":"read_file","arguments":{"path":"a.md"}}]')}`])
  assert.equal(result.text, "Let me look.\n")
  assert.deepEqual(result.calls, [{ name: "read_file", arguments: "{\"path\":\"a.md\"}" }])
})

test("markers split across chunks at every position are detected", () => {
  const full = `Intro\n${block('[{"name":"a","arguments":{}}]')}\n`
  for (let cut = 1; cut < full.length; cut += 1) {
    const result = collect(new StreamSplitter(M), [full.slice(0, cut), full.slice(cut)])
    assert.equal(result.text, "Intro\n", `cut at ${cut}`)
    assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }], `cut at ${cut}`)
  }
})

test("text and a second block after the closing marker are dropped and counted", () => {
  const after = `\nMore text\n${block('[{"name":"b"}]')}`
  const result = collect(new StreamSplitter(M), [block('[{"name":"a"}]') + after])
  assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }])
  assert.equal(result.summary.droppedChars, after.length - 1)
})

test("a closing marker at the very end without a newline is accepted", () => {
  const result = collect(new StreamSplitter(M), [block('[{"name":"a"}]')])
  assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }])
})

test("marker text inside a JSON string does not end the block", () => {
  const json = JSON.stringify([{ name: "echo", arguments: { text: `</${M}>` } }])
  const result = collect(new StreamSplitter(M), [block(json)])
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { text: `</${M}>` })
})

test("Windows line endings are accepted", () => {
  const result = collect(new StreamSplitter(M), [`<${M}>\r\n[{"name":"a"}]\r\n</${M}>\r\n`])
  assert.deepEqual(result.calls, [{ name: "a", arguments: "{}" }])
})

test("an invalid block is returned as text, and later output passes through", () => {
  const result = collect(new StreamSplitter(M), [`${block('{"name":"a"}')}\nafter`])
  assert.equal(result.calls.length, 0)
  assert.equal(result.text, `<${M}>\n{"name":"a"}\n</${M}>\nafter`)
  assert.equal(result.summary.invalidBlockReason, "not a JSON array")
})

test("a block without a closing marker is returned as text at the end", () => {
  const result = collect(new StreamSplitter(M), [`Hi\n<${M}>\n[{"name":"a"}]`])
  assert.equal(result.text, `Hi\n<${M}>\n[{"name":"a"}]`)
  assert.equal(result.summary.invalidBlockReason, "missing closing marker")
})

test("a block over 1 MB is returned as text", () => {
  const huge = "x".repeat(MAX_BLOCK_BYTES + 10)
  const result = collect(new StreamSplitter(M), [`<${M}>\n`, huge])
  assert.equal(result.calls.length, 0)
  assert.equal(result.summary.invalidBlockReason, "block too large")
  assert.ok(result.text.endsWith(huge))
})

test("a marker line with nothing after it at the end is plain text", () => {
  assert.equal(collect(new StreamSplitter(M), [`<${M}>`]).text, `<${M}>`)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/prompt/stream-splitter.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/prompt/stream-splitter.ts`:

```typescript
import { closingLine, MAX_BLOCK_BYTES, openingLine, parseToolBlock, type ParsedToolCall } from "./tool-protocol.js"

export type SplitterEvent = { type: "text"; text: string } | { type: "tool_calls"; calls: ParsedToolCall[] }
export type SplitterSummary = { droppedChars: number; invalidBlockReason?: string }

type State = "text" | "block" | "after" | "passthrough"

const withoutCarriageReturn = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line)

export class StreamSplitter {
  private state: State
  private pending = ""
  private block = ""
  private scanned = 0
  private dropped = 0
  private invalidReason: string | undefined
  private readonly opening: string
  private readonly closing: string

  constructor(marker: string | undefined) {
    this.state = marker ? "text" : "passthrough"
    this.opening = marker ? openingLine(marker) : ""
    this.closing = marker ? closingLine(marker) : ""
  }

  push(chunk: string): SplitterEvent[] {
    const events: SplitterEvent[] = []
    if (!chunk) return events
    if (this.state === "passthrough") events.push({ type: "text", text: chunk })
    else if (this.state === "after") this.dropped += chunk.length
    else if (this.state === "text") this.pushText(chunk, events)
    else this.pushBlock(chunk, events)
    return events
  }

  end(): { events: SplitterEvent[]; summary: SplitterSummary } {
    const events: SplitterEvent[] = []
    if (this.state === "text" && this.pending) {
      events.push({ type: "text", text: this.pending })
      this.pending = ""
    } else if (this.state === "block") {
      const tail = withoutCarriageReturn(this.block.slice(this.scanned))
      const result = tail === this.closing ? parseToolBlock(this.block.slice(0, this.scanned)) : undefined
      if (result?.ok) {
        events.push({ type: "tool_calls", calls: result.calls })
        this.state = "after"
      } else {
        this.failBlock(result ? result.reason : "missing closing marker", events)
      }
    }
    return { events, summary: { droppedChars: this.dropped, invalidBlockReason: this.invalidReason } }
  }

  private pushText(chunk: string, events: SplitterEvent[]): void {
    let buffer = this.pending + chunk
    this.pending = ""
    let output = ""
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      if (withoutCarriageReturn(buffer.slice(0, newline)) === this.opening) {
        if (output) events.push({ type: "text", text: output })
        this.state = "block"
        this.block = ""
        this.scanned = 0
        const rest = buffer.slice(newline + 1)
        if (rest) this.pushBlock(rest, events)
        return
      }
      output += buffer.slice(0, newline + 1)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
    if (buffer && this.opening.startsWith(buffer)) this.pending = buffer
    else output += buffer
    if (output) events.push({ type: "text", text: output })
  }

  private pushBlock(chunk: string, events: SplitterEvent[]): void {
    this.block += chunk
    if (Buffer.byteLength(this.block) > MAX_BLOCK_BYTES + this.closing.length + 2) {
      this.failBlock("block too large", events)
      return
    }
    let lineStart = this.scanned
    let newline = this.block.indexOf("\n", lineStart)
    while (newline !== -1) {
      if (withoutCarriageReturn(this.block.slice(lineStart, newline)) === this.closing) {
        const result = parseToolBlock(this.block.slice(0, lineStart))
        if (result.ok) {
          events.push({ type: "tool_calls", calls: result.calls })
          this.state = "after"
          this.dropped += this.block.length - (newline + 1)
          this.block = ""
          return
        }
        if (!result.retryable) {
          this.failBlock(result.reason, events)
          return
        }
      }
      lineStart = newline + 1
      newline = this.block.indexOf("\n", lineStart)
    }
    this.scanned = lineStart
  }

  private failBlock(reason: string, events: SplitterEvent[]): void {
    events.push({ type: "text", text: `${this.opening}\n${this.block}` })
    this.invalidReason = reason
    this.block = ""
    this.state = "passthrough"
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/prompt/stream-splitter.ts test/unit/stream-splitter.test.ts
git commit -m "feat: split streamed output into text and one tool block"
```

---

### Task 8: Request rules

**Files:**
- Create: `src/openai/request-contract.ts`
- Test: `test/unit/request-contract.test.ts`

**Interfaces:**
- Consumes: `AdapterError` and chat types (Task 2).
- Produces:
  - `type NormalizedRequest = { model: string; messages: ChatMessage[]; stream: boolean; includeUsage: boolean; tools: ChatTool[]; toolChoice: ToolChoice; parallelToolCalls: boolean; responseFormat: ResponseFormat }`
  - `MAX_IMAGES_PER_REQUEST = 10`
  - `normalizeRequest(body: unknown, defaultModel: string): NormalizedRequest` (throws `AdapterError` 400)
  - `isJsonFormat(format: ResponseFormat): boolean`
  - `imageUrlOf(part: ChatContentPart): string | undefined`

- [ ] **Step 1: Write the failing tests**

`test/unit/request-contract.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { AdapterError } from "../../src/openai/errors.js"
import { isJsonFormat, normalizeRequest } from "../../src/openai/request-contract.js"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const user = { role: "user", content: "hi" }
const rejects = (body: unknown, pattern: RegExp) =>
  assert.throws(() => normalizeRequest(body, "composer-2.5"), (error: unknown) => {
    assert.ok(error instanceof AdapterError)
    assert.equal(error.status, 400)
    assert.equal(error.code, "invalid_request_error")
    assert.match(error.message, pattern)
    return true
  })

test("applies defaults for missing fields", () => {
  assert.deepEqual(normalizeRequest({ messages: [user] }, "composer-2.5"), {
    model: "composer-2.5",
    messages: [user],
    stream: false,
    includeUsage: false,
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: true,
    responseFormat: { type: "text" },
  })
})

test("honors stream, usage, tools, tool_choice, parallel_tool_calls, and response_format", () => {
  const tool = { type: "function", function: { name: "read_file" } }
  const result = normalizeRequest(
    {
      model: "gpt-5.6-sol-high",
      messages: [user],
      stream: true,
      stream_options: { include_usage: true },
      tools: [tool],
      tool_choice: { type: "function", function: { name: "read_file" } },
      parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } },
    },
    "composer-2.5",
  )
  assert.equal(result.model, "gpt-5.6-sol-high")
  assert.equal(result.stream, true)
  assert.equal(result.includeUsage, true)
  assert.deepEqual(result.tools, [tool])
  assert.deepEqual(result.toolChoice, { type: "function", function: { name: "read_file" } })
  assert.equal(result.parallelToolCalls, false)
  assert.equal(isJsonFormat(result.responseFormat), true)
})

test("ignores fields the Cursor CLI cannot honor", () => {
  const result = normalizeRequest(
    { messages: [user], reasoning_effort: "high", max_tokens: 5, temperature: 0.1, top_p: 1, stop: ["x"], seed: 1, user: "u", metadata: {}, extra: 1 },
    "composer-2.5",
  )
  assert.equal(result.model, "composer-2.5")
})

test("rejects invalid bodies and fields", () => {
  rejects(null, /JSON object/)
  rejects([], /JSON object/)
  rejects({ messages: [] }, /non-empty array/)
  rejects({ messages: [user], n: 2 }, /n = 1/)
  rejects({ messages: [user], model: 5 }, /model/)
  rejects({ messages: [{ role: "robot", content: "x" }] }, /unsupported role/)
  rejects({ messages: [{ role: "user", content: 5 }] }, /content/)
  rejects({ messages: [{ role: "tool", content: "x" }] }, /tool_call_id/)
  rejects({ messages: [{ role: "assistant", tool_calls: [{ id: "a", function: { name: "x" } }] }] }, /invalid tool call/)
  rejects({ messages: [user], tools: [{ type: "code_interpreter" }] }, /function tools/)
  rejects({ messages: [user], tool_choice: "sometimes" }, /tool_choice/)
  rejects({ messages: [user], response_format: { type: "xml" } }, /response_format/)
})

test("accepts only embedded data:image addresses", () => {
  const withImage = (url: string) => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] })
  assert.doesNotThrow(() => normalizeRequest(withImage(PNG), "composer-2.5"))
  rejects(withImage("file:///etc/passwd"), /data:image/)
  rejects(withImage("https://example.com/a.png"), /data:image/)
  rejects(withImage("data:image/svg+xml;base64,PHN2Zz4="), /data:image/)
})

test("a history with more than 10 images is rejected with a clear message", () => {
  const image = { type: "image_url", image_url: { url: PNG } }
  const messages = Array.from({ length: 11 }, () => ({ role: "user", content: [image] }))
  rejects({ messages }, /At most 10 images/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/openai/request-contract.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/openai/request-contract.ts`:

```typescript
import { AdapterError } from "./errors.js"
import type { ChatContentPart, ChatMessage, ChatRequest, ChatTool, ResponseFormat, ToolChoice } from "./types.js"

export type NormalizedRequest = {
  model: string
  messages: ChatMessage[]
  stream: boolean
  includeUsage: boolean
  tools: ChatTool[]
  toolChoice: ToolChoice
  parallelToolCalls: boolean
  responseFormat: ResponseFormat
}

export const MAX_IMAGES_PER_REQUEST = 10

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"])
const IMAGE_ADDRESS = /^data:image\/(png|jpeg|gif|webp);base64,/

const invalid = (message: string): AdapterError => new AdapterError(400, "invalid_request_error", message)
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const imageUrlOf = (part: ChatContentPart): string | undefined =>
  typeof part.image_url === "string" ? part.image_url : part.image_url?.url

export const isJsonFormat = (format: ResponseFormat): boolean => format.type === "json_object" || format.type === "json_schema"

const validateMessage = (value: unknown, index: number): { message: ChatMessage; images: number } => {
  if (!isObject(value) || typeof value.role !== "string" || !ROLES.has(value.role)) {
    throw invalid(`messages[${index}] has an unsupported role`)
  }
  let images = 0
  const content = value.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObject(part) || typeof part.type !== "string") throw invalid(`messages[${index}] has an invalid content part`)
      if (part.type === "image_url") {
        const url = imageUrlOf(part as ChatContentPart)
        if (typeof url !== "string" || !IMAGE_ADDRESS.test(url)) {
          throw invalid("Images must be embedded as data:image/png, jpeg, gif, or webp base64 addresses")
        }
        images += 1
      }
    }
  } else if (content !== undefined && content !== null && typeof content !== "string") {
    throw invalid(`messages[${index}].content must be a string, an array, or null`)
  }
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) throw invalid(`messages[${index}].tool_calls must be an array`)
    for (const call of value.tool_calls) {
      const fn = isObject(call) && isObject(call.function) ? call.function : undefined
      if (!isObject(call) || typeof call.id !== "string" || !fn || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
        throw invalid(`messages[${index}] has an invalid tool call`)
      }
    }
  }
  if (value.role === "tool" && typeof value.tool_call_id !== "string") {
    throw invalid(`messages[${index}] is a tool result without tool_call_id`)
  }
  return { message: value as unknown as ChatMessage, images }
}

const normalizeTools = (value: unknown): ChatTool[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid("tools must be an array")
  return value.map((tool) => {
    if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function) || typeof tool.function.name !== "string" || !tool.function.name) {
      throw invalid("Only function tools with a name are supported")
    }
    return tool as unknown as ChatTool
  })
}

const normalizeToolChoice = (value: unknown): ToolChoice => {
  if (value === undefined || value === null) return "auto"
  if (value === "auto" || value === "none" || value === "required") return value
  if (isObject(value) && value.type === "function" && isObject(value.function) && typeof value.function.name === "string") {
    return { type: "function", function: { name: value.function.name } }
  }
  throw invalid("Unsupported tool_choice value")
}

const normalizeResponseFormat = (value: unknown): ResponseFormat => {
  if (value === undefined || value === null) return { type: "text" }
  if (isObject(value)) {
    if (value.type === "text" || value.type === "json_object") return { type: value.type }
    if (value.type === "json_schema") {
      return {
        type: "json_schema",
        json_schema: isObject(value.json_schema) ? (value.json_schema as { name?: string; schema?: unknown; strict?: boolean }) : undefined,
      }
    }
  }
  throw invalid("Unsupported response_format value")
}

export const normalizeRequest = (body: unknown, defaultModel: string): NormalizedRequest => {
  if (!isObject(body)) throw invalid("Request body must be a JSON object")
  const request = body as ChatRequest
  if (request.n !== undefined && request.n !== 1) throw invalid("Only n = 1 is supported")
  if (request.model !== undefined && (typeof request.model !== "string" || !request.model)) {
    throw invalid("model must be a non-empty string")
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw invalid("messages must be a non-empty array")

  let images = 0
  const messages = request.messages.map((value, index) => {
    const validated = validateMessage(value, index)
    images += validated.images
    return validated.message
  })
  if (images > MAX_IMAGES_PER_REQUEST) throw invalid(`At most ${MAX_IMAGES_PER_REQUEST} images are allowed per request`)

  return {
    model: typeof request.model === "string" ? request.model : defaultModel,
    messages,
    stream: request.stream === true,
    includeUsage: isObject(request.stream_options) && request.stream_options.include_usage === true,
    tools: normalizeTools(request.tools),
    toolChoice: normalizeToolChoice(request.tool_choice),
    parallelToolCalls: request.parallel_tool_calls !== false,
    responseFormat: normalizeResponseFormat(request.response_format),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/openai/request-contract.ts test/unit/request-contract.test.ts
git commit -m "feat: validate and normalize chat requests"
```

---

### Task 9: Prompt builder

**Files:**
- Create: `src/prompt/prompt-builder.ts`
- Test: `test/unit/prompt-builder.test.ts`

**Interfaces:**
- Consumes: `NormalizedRequest` (Task 8), `toolInstructions`, `toolReminder` (Task 6), `ChatMessage`, `ResponseFormat` (Task 2).
- Produces:
  - `type ImagePaths = ReadonlyMap<string, string>` (key from `imageKey`, value is a path relative to the workspace)
  - `imageKey(messageIndex: number, partIndex: number): string`
  - `toolsActive(request: NormalizedRequest): boolean`
  - `jsonInstructions(format: ResponseFormat): string | undefined`
  - `stripCodeFences(text: string): string`
  - `buildFullPrompt(request: NormalizedRequest, marker: string, images: ImagePaths): string`
  - `buildContinuedPrompt(request: NormalizedRequest, fromIndex: number, marker: string, images: ImagePaths): string`

- [ ] **Step 1: Write the failing tests**

`test/unit/prompt-builder.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import type { NormalizedRequest } from "../../src/openai/request-contract.js"
import type { ChatMessage } from "../../src/openai/types.js"
import {
  buildContinuedPrompt,
  buildFullPrompt,
  imageKey,
  jsonInstructions,
  stripCodeFences,
  toolsActive,
} from "../../src/prompt/prompt-builder.js"

const M = "TOOL_CALLS_abcdef01"
const readTool = { type: "function" as const, function: { name: "read_file", description: "Read a file" } }
const call = { id: "call_1", type: "function" as const, function: { name: "read_file", arguments: "{\"path\":\"a.md\"}" } }
const history: ChatMessage[] = [
  { role: "system", content: "You are Hermes." },
  { role: "user", content: "Read a.md" },
  { role: "assistant", content: "", tool_calls: [call] },
  { role: "tool", content: "contents of a.md", tool_call_id: "call_1" },
]
const request = (overrides: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  model: "composer-2.5",
  messages: history,
  stream: false,
  includeUsage: false,
  tools: [readTool],
  toolChoice: "auto",
  parallelToolCalls: true,
  responseFormat: { type: "text" },
  ...overrides,
})
const noImages = new Map<string, string>()

test("the full prompt has tool instructions, system text, and the labeled conversation in order", () => {
  const prompt = buildFullPrompt(request(), M, noImages)
  const tools = prompt.indexOf(`<${M}>`)
  const system = prompt.indexOf("System instructions:\nYou are Hermes.")
  const user = prompt.indexOf("User:\nRead a.md")
  assert.ok(tools >= 0 && system > tools && user > system)
  assert.ok(prompt.includes("read_file: Read a file"))
  assert.ok(prompt.includes(`Assistant tool calls:\n[{"id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a.md\\"}"}]`))
  assert.ok(prompt.includes("Tool result (read_file, id call_1):\ncontents of a.md"))
})

test("tool instructions are left out when there are no tools or tool_choice is none", () => {
  assert.ok(!buildFullPrompt(request({ tools: [] }), M, noImages).includes(M))
  assert.ok(!buildFullPrompt(request({ toolChoice: "none" }), M, noImages).includes(M))
  assert.equal(toolsActive(request({ toolChoice: "none" })), false)
  assert.equal(toolsActive(request()), true)
})

test("a tool result without a matching call is labeled as unknown", () => {
  const prompt = buildFullPrompt(request({ messages: [{ role: "tool", content: "x", tool_call_id: "call_9" }] }), M, noImages)
  assert.ok(prompt.includes("Tool result (unknown tool, id call_9):\nx"))
})

test("JSON instructions follow response_format", () => {
  assert.equal(jsonInstructions({ type: "text" }), undefined)
  assert.match(jsonInstructions({ type: "json_object" }) ?? "", /single JSON object only/)
  const schema = jsonInstructions({ type: "json_schema", json_schema: { schema: { type: "object", required: ["title"] } } }) ?? ""
  assert.ok(schema.includes("{\"type\":\"object\",\"required\":[\"title\"]}"))
  assert.ok(buildFullPrompt(request({ responseFormat: { type: "json_object" } }), M, noImages).includes("single JSON object only"))
})

test("images are referenced inline, with one instruction to view them", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ]
  const paths = new Map([[imageKey(0, 1), "attachments/r1/image-1.png"]])
  const prompt = buildFullPrompt(request({ messages, tools: [] }), M, paths)
  assert.ok(prompt.includes("User:\nWhat is this?\n[Image: attachments/r1/image-1.png]"))
  assert.ok(prompt.includes("View each file named in an [Image: <path>] reference"))
  const withoutPath = buildFullPrompt(request({ messages, tools: [] }), M, noImages)
  assert.ok(withoutPath.includes("[Image: shown earlier in this conversation]"))
  assert.ok(!withoutPath.includes("View each file"))
})

test("the continued prompt has only the new messages and a reminder", () => {
  const prompt = buildContinuedPrompt(request(), 3, M, noImages)
  assert.ok(prompt.startsWith("Tool result (read_file, id call_1):\ncontents of a.md"))
  assert.ok(!prompt.includes("Read a.md"))
  assert.ok(!prompt.includes("You are Hermes."))
  assert.ok(!prompt.includes("Available tools:"))
  assert.ok(prompt.includes(`<${M}>`))
})

test("the continued prompt includes JSON instructions when requested", () => {
  const prompt = buildContinuedPrompt(request({ responseFormat: { type: "json_object" }, tools: [] }), 3, M, noImages)
  assert.ok(prompt.includes("single JSON object only"))
  assert.ok(!prompt.includes(M))
})

test("stripCodeFences removes one surrounding fence", () => {
  assert.equal(stripCodeFences("```json\n{\"a\":1}\n```"), "{\"a\":1}")
  assert.equal(stripCodeFences("  ```\n{\"a\":1}\n```  \n"), "{\"a\":1}")
  assert.equal(stripCodeFences("{\"a\":1}\n"), "{\"a\":1}")
  assert.equal(stripCodeFences("text with ``` inside"), "text with ``` inside")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/prompt/prompt-builder.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/prompt/prompt-builder.ts`:

```typescript
import type { NormalizedRequest } from "../openai/request-contract.js"
import type { ChatMessage, ResponseFormat } from "../openai/types.js"
import { toolInstructions, toolReminder } from "./tool-protocol.js"

export type ImagePaths = ReadonlyMap<string, string>

export const imageKey = (messageIndex: number, partIndex: number): string => `${messageIndex}:${partIndex}`

export const toolsActive = (request: NormalizedRequest): boolean => request.tools.length > 0 && request.toolChoice !== "none"

export const jsonInstructions = (format: ResponseFormat): string | undefined => {
  if (format.type === "json_object") return "Answer with a single JSON object only. Do not add any other text or code fences."
  if (format.type === "json_schema") {
    return `Answer with a single JSON object only, matching this JSON schema. Do not add any other text or code fences.\n${JSON.stringify(format.json_schema?.schema ?? {})}`
  }
  return undefined
}

export const stripCodeFences = (text: string): string => {
  const match = /^\s*```[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  return match ? match[1] : text.trim()
}

const isSystem = (message: ChatMessage): boolean => message.role === "system" || message.role === "developer"

const contentText = (message: ChatMessage, messageIndex: number, images: ImagePaths): string => {
  const { content } = message
  if (content === null || content === undefined) return ""
  if (typeof content === "string") return content
  return content
    .map((part, partIndex) => {
      if (part.type === "text") return part.text ?? ""
      if (part.type === "image_url") {
        const path = images.get(imageKey(messageIndex, partIndex))
        return path ? `[Image: ${path}]` : "[Image: shown earlier in this conversation]"
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

const toolNamesById = (messages: ChatMessage[]): Map<string, string> => {
  const names = new Map<string, string>()
  for (const message of messages) for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
  return names
}

const renderMessage = (message: ChatMessage, index: number, images: ImagePaths, names: Map<string, string>): string => {
  const text = contentText(message, index, images)
  if (isSystem(message)) return `System instructions:\n${text}`
  if (message.role === "user") return `User:\n${text}`
  if (message.role === "tool") {
    const id = message.tool_call_id ?? ""
    return `Tool result (${names.get(id) ?? "unknown tool"}, id ${id}):\n${text}`
  }
  const parts: string[] = []
  if (text.trim()) parts.push(`Assistant:\n${text}`)
  if (message.tool_calls?.length) {
    const calls = message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }))
    parts.push(`Assistant tool calls:\n${JSON.stringify(calls)}`)
  }
  return parts.length > 0 ? parts.join("\n\n") : "Assistant:\n"
}

const imageInstruction = (images: ImagePaths): string | undefined =>
  images.size > 0
    ? "Images are attached as files. View each file named in an [Image: <path>] reference with your file-reading tool. Paths are relative to your workspace."
    : undefined

export const buildFullPrompt = (request: NormalizedRequest, marker: string, images: ImagePaths): string => {
  const names = toolNamesById(request.messages)
  const sections: string[] = []
  if (toolsActive(request)) {
    sections.push(toolInstructions({ marker, tools: request.tools, toolChoice: request.toolChoice, parallelToolCalls: request.parallelToolCalls }))
  }
  const json = jsonInstructions(request.responseFormat)
  if (json) sections.push(json)
  const system = request.messages.flatMap((message, index) => (isSystem(message) ? [contentText(message, index, images)] : []))
  if (system.length > 0) sections.push(`System instructions:\n${system.join("\n\n")}`)
  const conversation = request.messages.flatMap((message, index) => (isSystem(message) ? [] : [renderMessage(message, index, images, names)]))
  sections.push(`Conversation:\n\n${conversation.join("\n\n")}`)
  const instruction = imageInstruction(images)
  if (instruction) sections.push(instruction)
  return sections.join("\n\n")
}

export const buildContinuedPrompt = (request: NormalizedRequest, fromIndex: number, marker: string, images: ImagePaths): string => {
  const names = toolNamesById(request.messages)
  const sections = [
    request.messages
      .slice(fromIndex)
      .map((message, offset) => renderMessage(message, fromIndex + offset, images, names))
      .join("\n\n"),
  ]
  const instruction = imageInstruction(images)
  if (instruction) sections.push(instruction)
  if (toolsActive(request)) sections.push(toolReminder({ marker, toolChoice: request.toolChoice, parallelToolCalls: request.parallelToolCalls }))
  const json = jsonInstructions(request.responseFormat)
  if (json) sections.push(json)
  return sections.join("\n\n")
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/prompt/prompt-builder.ts test/unit/prompt-builder.test.ts
git commit -m "feat: build full and continued prompts"
```

---

### Task 10: Screenshot attachments

**Files:**
- Create: `src/images/attachments.ts`
- Test: `test/unit/attachments.test.ts`

**Interfaces:**
- Consumes: `AdapterError`, `ChatMessage` (Task 2), `imageUrlOf` (Task 8), `imageKey`, `ImagePaths` (Task 9).
- Produces:
  - `MAX_IMAGE_BYTES = 5 * 1024 * 1024`, `MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024`
  - `decodeImageDataUrl(url: string): { type: "png" | "jpeg" | "gif" | "webp"; extension: string; data: Buffer }` (throws `AdapterError` 400)
  - `type SavedImages = { paths: ImagePaths; cleanup(): Promise<void> }`
  - `saveImages(input: { workspaceDir: string; requestId: string; messages: ChatMessage[]; fromIndex: number }): Promise<SavedImages>` (writes under `<workspaceDir>/attachments/<requestId>/`)

- [ ] **Step 1: Write the failing tests**

`test/unit/attachments.test.ts`:

```typescript
import assert from "node:assert/strict"
import { mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { decodeImageDataUrl, MAX_IMAGE_BYTES, saveImages } from "../../src/images/attachments.js"
import { AdapterError } from "../../src/openai/errors.js"
import type { ChatMessage } from "../../src/openai/types.js"
import { imageKey } from "../../src/prompt/prompt-builder.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const dataUrl = (type: string, bytes: Buffer) => `data:image/${type};base64,${bytes.toString("base64")}`
const png = (size = 16) => Buffer.concat([PNG_HEADER, Buffer.alloc(size)])
const imageMessage = (url: string): ChatMessage => ({ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url } }] })
const isBadRequest = (error: unknown) => error instanceof AdapterError && error.status === 400

let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
  await mkdir(join(dir.path, "attachments"), { mode: 0o700 })
})
afterEach(() => dir.cleanup())

test("decodes each allowed image type", () => {
  assert.equal(decodeImageDataUrl(dataUrl("png", png())).extension, "png")
  assert.equal(decodeImageDataUrl(dataUrl("jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).extension, "jpg")
  assert.equal(decodeImageDataUrl(dataUrl("gif", Buffer.from("GIF89a\x01\x00", "latin1"))).extension, "gif")
  assert.equal(decodeImageDataUrl(dataUrl("webp", Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1"))).extension, "webp")
})

test("rejects invalid base64, mismatched types, and oversized images", () => {
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,iVBORw0KGgo"), isBadRequest)
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,iVBO$w0K"), isBadRequest)
  assert.throws(() => decodeImageDataUrl("data:image/png;base64,iVBORw0KGgp="), isBadRequest)
  assert.throws(() => decodeImageDataUrl(dataUrl("png", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), /does not match/)
  assert.throws(() => decodeImageDataUrl(dataUrl("png", png(MAX_IMAGE_BYTES))), /at most 5 MB/)
})

test("saves images from fromIndex onward with private permissions, and cleans up", async () => {
  const messages = [imageMessage(dataUrl("png", png(1))), { role: "assistant" as const, content: "ok" }, imageMessage(dataUrl("png", png(2)))]
  const saved = await saveImages({ workspaceDir: dir.path, requestId: "r1", messages, fromIndex: 1 })
  assert.deepEqual([...saved.paths.entries()], [[imageKey(2, 1), join("attachments", "r1", "image-1.png")]])
  const folder = join(dir.path, "attachments", "r1")
  assert.equal((await stat(folder)).mode & 0o777, 0o700)
  assert.equal((await stat(join(folder, "image-1.png"))).mode & 0o777, 0o600)
  await saved.cleanup()
  assert.deepEqual(await readdir(join(dir.path, "attachments")), [])
})

test("creates nothing when there are no images", async () => {
  const saved = await saveImages({ workspaceDir: dir.path, requestId: "r2", messages: [{ role: "user", content: "hi" }], fromIndex: 0 })
  assert.equal(saved.paths.size, 0)
  assert.deepEqual(await readdir(join(dir.path, "attachments")), [])
})

test("refuses to reuse an existing request folder", async () => {
  await mkdir(join(dir.path, "attachments", "r3"))
  await assert.rejects(saveImages({ workspaceDir: dir.path, requestId: "r3", messages: [imageMessage(dataUrl("png", png()))], fromIndex: 0 }), /EEXIST/)
})

test("rejects more than 20 MB of images in one request", async () => {
  const large = dataUrl("png", png(Math.floor(MAX_IMAGE_BYTES * 0.9)))
  const messages = Array.from({ length: 5 }, () => imageMessage(large))
  await assert.rejects(saveImages({ workspaceDir: dir.path, requestId: "r4", messages, fromIndex: 0 }), /total at most 20 MB/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/images/attachments.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/images/attachments.ts`:

```typescript
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AdapterError } from "../openai/errors.js"
import { imageUrlOf } from "../openai/request-contract.js"
import type { ChatMessage } from "../openai/types.js"
import { imageKey, type ImagePaths } from "../prompt/prompt-builder.js"

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

const EXTENSIONS = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" } as const
type ImageType = keyof typeof EXTENSIONS

const invalid = (message: string): AdapterError => new AdapterError(400, "invalid_request_error", message)

const matchesSignature = (type: ImageType, data: Buffer): boolean => {
  switch (type) {
    case "png":
      return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case "jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    case "gif": {
      const header = data.subarray(0, 6).toString("latin1")
      return header === "GIF87a" || header === "GIF89a"
    }
    case "webp":
      return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP"
  }
}

export const decodeImageDataUrl = (url: string): { type: ImageType; extension: string; data: Buffer } => {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([\s\S]*)$/.exec(url)
  if (!match) throw invalid("Images must be embedded as data:image/png, jpeg, gif, or webp base64 addresses")
  const type = match[1] as ImageType
  const base64 = match[2]
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw invalid("Image data is not valid base64")
  }
  if ((base64.length / 4) * 3 > MAX_IMAGE_BYTES + 2) throw invalid("Each image must be at most 5 MB")
  const data = Buffer.from(base64, "base64")
  if (data.toString("base64") !== base64) throw invalid("Image data is not valid base64")
  if (data.length > MAX_IMAGE_BYTES) throw invalid("Each image must be at most 5 MB")
  if (!matchesSignature(type, data)) throw invalid(`Image data does not match the declared ${type} type`)
  return { type, extension: EXTENSIONS[type], data }
}

export type SavedImages = { paths: ImagePaths; cleanup(): Promise<void> }

export const saveImages = async (input: {
  workspaceDir: string
  requestId: string
  messages: ChatMessage[]
  fromIndex: number
}): Promise<SavedImages> => {
  const decoded: Array<{ key: string; extension: string; data: Buffer }> = []
  let total = 0
  for (let messageIndex = input.fromIndex; messageIndex < input.messages.length; messageIndex += 1) {
    const content = input.messages[messageIndex].content
    if (!Array.isArray(content)) continue
    content.forEach((part, partIndex) => {
      if (part.type !== "image_url") return
      const image = decodeImageDataUrl(imageUrlOf(part) ?? "")
      total += image.data.length
      if (total > MAX_TOTAL_IMAGE_BYTES) throw invalid("Images in one request must total at most 20 MB")
      decoded.push({ key: imageKey(messageIndex, partIndex), extension: image.extension, data: image.data })
    })
  }
  if (decoded.length === 0) return { paths: new Map(), cleanup: async () => {} }

  const relativeDir = join("attachments", input.requestId)
  const absoluteDir = join(input.workspaceDir, relativeDir)
  await mkdir(absoluteDir, { mode: 0o700 })
  const cleanup = () => rm(absoluteDir, { recursive: true, force: true })
  const paths = new Map<string, string>()
  try {
    for (const [index, image] of decoded.entries()) {
      const name = `image-${index + 1}.${image.extension}`
      await writeFile(join(absoluteDir, name), image.data, { mode: 0o600, flag: "wx" })
      paths.set(image.key, join(relativeDir, name))
    }
  } catch (error) {
    await cleanup()
    throw error
  }
  return { paths, cleanup }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/images/attachments.ts test/unit/attachments.test.ts
git commit -m "feat: validate and save screenshots for one request"
```

---

### Task 11: Workspace and permissions file

**Files:**
- Create: `src/cursor/workspace-permissions.ts`
- Test: `test/unit/workspace-permissions.test.ts`

**Interfaces:**
- Consumes: `StartupError`, `AdapterError` (Task 2).
- Produces:
  - `type PlatformPaths = { home: string; realHome: string; platform: NodeJS.Platform }`
  - `type PermissionsFile = { permissions: { allow: string[]; deny: string[] } }`
  - `deniedReadRoots(paths: PlatformPaths): string[]`
  - `buildPermissions(paths: PlatformPaths): PermissionsFile`
  - `permissionsFileText(paths: PlatformPaths): string`
  - `assertNoSymlinks(path: string): Promise<void>` (throws `StartupError`)
  - `prepareWorkspace(input: { workspaceDir: string; paths: PlatformPaths; uid: number }): Promise<string>` (startup checks 7 to 10; returns the permissions file text)
  - `ensureWorkspaceReady(workspaceDir: string, expectedPermissions: string): Promise<void>` (before each run; throws `AdapterError` 503 when unsafe)

- [ ] **Step 1: Write the failing tests**

`test/unit/workspace-permissions.test.ts`:

```typescript
import assert from "node:assert/strict"
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
  buildPermissions,
  ensureWorkspaceReady,
  permissionsFileText,
  prepareWorkspace,
} from "../../src/cursor/workspace-permissions.js"
import { AdapterError } from "../../src/openai/errors.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const uid = process.getuid?.() ?? 0
const paths = { home: "/nonexistent-home-c2o", realHome: "/nonexistent-home-c2o", platform: "linux" as const }
let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => dir.cleanup())

test("Linux rules deny tools, writes, and secret folders", () => {
  assert.deepEqual(buildPermissions({ home: "/home/u", realHome: "/home/u", platform: "linux" }), {
    permissions: {
      allow: [],
      deny: ["Shell(*)", "Write(**)", "Write(/**)", "WebFetch(*)", "Mcp(*:*)", "Read(~/**)", "Read(/home/u/**)", "Read(/etc/**)", "Read(/root/**)"],
    },
  })
})

test("macOS rules add every home and /etc spelling", () => {
  const deny = buildPermissions({ home: "/Users/u", realHome: "/Volumes/Home/u", platform: "darwin" }).permissions.deny
  for (const rule of [
    "Read(/Users/u/**)",
    "Read(/Volumes/Home/u/**)",
    "Read(/System/Volumes/Data/Users/u/**)",
    "Read(/private/etc/**)",
    "Read(/System/Volumes/Data/private/etc/**)",
  ]) {
    assert.ok(deny.includes(rule), rule)
  }
})

test("prepareWorkspace creates the folders and the permissions file", async () => {
  const workspace = join(dir.path, "ws")
  const text = await prepareWorkspace({ workspaceDir: workspace, paths, uid })
  assert.equal(text, permissionsFileText(paths))
  for (const folder of [workspace, join(workspace, ".cursor"), join(workspace, "attachments")]) {
    assert.equal((await stat(folder)).mode & 0o777, 0o700, folder)
  }
  assert.equal(await readFile(join(workspace, ".cursor", "cli.json"), "utf8"), text)
})

test("prepareWorkspace refuses a workspace inside a denied folder", async () => {
  await assert.rejects(
    prepareWorkspace({ workspaceDir: join(dir.path, "ws"), paths: { ...paths, home: dir.path, realHome: dir.path }, uid }),
    /must not be inside/,
  )
})

test("prepareWorkspace refuses symbolic links in the path", async () => {
  await mkdir(join(dir.path, "real"))
  await symlink(join(dir.path, "real"), join(dir.path, "link"))
  await assert.rejects(prepareWorkspace({ workspaceDir: join(dir.path, "link", "ws"), paths, uid }), /symbolic links/)
})

test("prepareWorkspace refuses the wrong mode or owner", async () => {
  const workspace = join(dir.path, "ws")
  await mkdir(workspace)
  await chmod(workspace, 0o755)
  await assert.rejects(prepareWorkspace({ workspaceDir: workspace, paths, uid }), /mode 0700/)
  await chmod(workspace, 0o700)
  await assert.rejects(prepareWorkspace({ workspaceDir: workspace, paths, uid: uid + 1 }), /owned by/)
})

test("prepareWorkspace shows the setup command when the parent folder is missing", async () => {
  await assert.rejects(prepareWorkspace({ workspaceDir: join(dir.path, "missing", "ws"), paths, uid }), /sudo install -d/)
})

test("ensureWorkspaceReady restores a changed or deleted permissions file and a missing attachments folder", async () => {
  const workspace = join(dir.path, "ws")
  const text = await prepareWorkspace({ workspaceDir: workspace, paths, uid })
  const file = join(workspace, ".cursor", "cli.json")
  await writeFile(file, "{}")
  await ensureWorkspaceReady(workspace, text)
  assert.equal(await readFile(file, "utf8"), text)
  await rm(file)
  await rm(join(workspace, "attachments"), { recursive: true })
  await ensureWorkspaceReady(workspace, text)
  assert.equal(await readFile(file, "utf8"), text)
  assert.ok((await stat(join(workspace, "attachments"))).isDirectory())
})

test("ensureWorkspaceReady refuses a symbolic link in place of attachments", async () => {
  const workspace = join(dir.path, "ws")
  const text = await prepareWorkspace({ workspaceDir: workspace, paths, uid })
  await rm(join(workspace, "attachments"), { recursive: true })
  await symlink(dir.path, join(workspace, "attachments"))
  await assert.rejects(ensureWorkspaceReady(workspace, text), (error: unknown) => error instanceof AdapterError && error.status === 503)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/cursor/workspace-permissions.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/cursor/workspace-permissions.ts`:

```typescript
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { AdapterError } from "../openai/errors.js"
import { StartupError } from "../startup-error.js"

export type PlatformPaths = { home: string; realHome: string; platform: NodeJS.Platform }
export type PermissionsFile = { permissions: { allow: string[]; deny: string[] } }

export const deniedReadRoots = ({ home, realHome, platform }: PlatformPaths): string[] => {
  const roots = new Set([home, realHome])
  if (platform === "darwin") {
    roots.add(`/System/Volumes/Data${home}`)
    roots.add(`/System/Volumes/Data${realHome}`)
  }
  roots.add("/etc")
  roots.add("/root")
  if (platform === "darwin") {
    roots.add("/private/etc")
    roots.add("/System/Volumes/Data/private/etc")
  }
  return [...roots]
}

// Deny rules always win over allow rules in Cursor, and allow rules do not restrict unlisted reads, so the file has no allow rules.
export const buildPermissions = (paths: PlatformPaths): PermissionsFile => ({
  permissions: {
    allow: [],
    deny: [
      "Shell(*)",
      "Write(**)",
      "Write(/**)",
      "WebFetch(*)",
      "Mcp(*:*)",
      "Read(~/**)",
      ...deniedReadRoots(paths).map((root) => `Read(${root}/**)`),
    ],
  },
})

export const permissionsFileText = (paths: PlatformPaths): string => `${JSON.stringify(buildPermissions(paths), null, 2)}\n`

const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

export const assertNoSymlinks = async (path: string): Promise<void> => {
  let current = sep
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (info.isSymbolicLink()) throw new StartupError(`The workspace path must not contain symbolic links: ${current}`)
  }
}

const ensurePrivateDirectory = async (path: string, uid: number, label: string): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new StartupError(`${label} must be a real folder: ${path}`)
  if (info.uid !== uid) throw new StartupError(`${label} must be owned by the adapter's user: ${path}`)
  if ((info.mode & 0o777) !== 0o700) throw new StartupError(`${label} must have mode 0700: ${path}`)
}

const writePermissionsFile = async (workspaceDir: string, text: string): Promise<void> => {
  const folder = join(workspaceDir, ".cursor")
  const temp = join(folder, `cli.json.${process.pid}.tmp`)
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, join(folder, "cli.json"))
}

export const prepareWorkspace = async (input: { workspaceDir: string; paths: PlatformPaths; uid: number }): Promise<string> => {
  const workspace = resolve(input.workspaceDir)
  if (!isAbsolute(input.workspaceDir)) throw new StartupError("CURSOR2OPENAI_WORKSPACE_DIR must be an absolute path")
  await assertNoSymlinks(workspace)
  for (const root of deniedReadRoots(input.paths)) {
    if (isInside(workspace, root)) {
      throw new StartupError(`The workspace folder must not be inside ${root}, because the permissions file denies reads there`)
    }
  }
  try {
    await mkdir(workspace, { mode: 0o700 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EACCES") {
      throw new StartupError(`Cannot create the workspace folder ${workspace}. Create it once with: sudo install -d -o "$USER" -m 700 ${workspace}`)
    }
    if (code !== "EEXIST") throw error
  }
  await ensurePrivateDirectory(workspace, input.uid, "The workspace folder")
  if ((await realpath(workspace)) !== workspace) throw new StartupError("The workspace folder's real path must equal the configured path")
  await ensurePrivateDirectory(join(workspace, ".cursor"), input.uid, "The workspace .cursor folder")
  await ensurePrivateDirectory(join(workspace, "attachments"), input.uid, "The workspace attachments folder")
  const text = permissionsFileText(input.paths)
  await writePermissionsFile(workspace, text)
  return text
}

const ensureRealFolder = async (path: string): Promise<void> => {
  const info = await lstat(path).catch(() => undefined)
  if (!info) {
    await mkdir(path, { mode: 0o700 })
    return
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AdapterError(503, "service_unavailable", "The adapter workspace is not in a safe state")
  }
}

export const ensureWorkspaceReady = async (workspaceDir: string, expectedPermissions: string): Promise<void> => {
  await ensureRealFolder(join(workspaceDir, "attachments"))
  await ensureRealFolder(join(workspaceDir, ".cursor"))
  const current = await readFile(join(workspaceDir, ".cursor", "cli.json"), "utf8").catch(() => undefined)
  if (current !== expectedPermissions) await writePermissionsFile(workspaceDir, expectedPermissions)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cursor/workspace-permissions.ts test/unit/workspace-permissions.test.ts
git commit -m "feat: prepare the workspace and Cursor permissions file"
```

---

### Task 12: Running the Cursor CLI

**Files:**
- Create: `src/cursor/error-classifier.ts`, `src/cursor/agent-runner.ts`, `test/helpers/fake-agent.ts`, `test/helpers/agent-events.ts`
- Test: `test/unit/error-classifier.test.ts`, `test/unit/agent-runner.test.ts`

**Interfaces:**
- Consumes: `AdapterError` (Task 2), fixtures from Task 1 (optional).
- Produces:
  - `classifyAgentFailure(input: { stderr: string; exitCode: number | null }): AdapterError` (the error's `detail` holds the raw output)
  - `type AgentUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }`
  - `type AgentRunInput = { agentBin: string; workspaceDir: string; model: string; prompt: string; resumeSessionId?: string; timeoutMs: number; signal?: AbortSignal; env: NodeJS.ProcessEnv }`
  - `type AgentRunResult = { sessionId?: string; resultText?: string; usage?: AgentUsage; deltaCount: number }`
  - `class AgentAbortedError extends Error`
  - `buildAgentArgs(input: { workspaceDir: string; model: string; resumeSessionId?: string }): string[]`
  - `buildAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `createAgentStreamParser(onText: (text: string) => void): { push(chunk: string): void; finish(): AgentRunResult }`
  - `runAgent(input: AgentRunInput, onText: (text: string) => void): Promise<AgentRunResult>`
  - `runAgentCommand(agentBin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }>`
  - Test helpers: `createFakeAgent(dir: string, options: FakeAgentOptions): Promise<FakeAgent>`; `initEvent`, `deltaEvent`, `toolFlushEvent`, `finalFlushEvent`, `resultEvent`, `replyLines(sessionId: string, text: string): string[]`, `toolReplyLines(sessionId: string, calls: Array<{ name: string; arguments?: unknown }>, before?: string): string[]`. A scenario line may contain `{{marker}}` (replaced with the marker found in the prompt) and `{{now}}` (replaced with the current time in milliseconds).

- [ ] **Step 1: Write the test helpers**

`test/helpers/agent-events.ts`:

```typescript
const assistant = (sessionId: string, text: string, extra: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId, ...extra })

export const initEvent = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "Composer 2.5", cwd: "/fake" })
export const deltaEvent = (sessionId: string, text: string): string => assistant(sessionId, text, { timestamp_ms: 1 })
export const toolFlushEvent = (sessionId: string, text: string): string => assistant(sessionId, text, { timestamp_ms: 2, model_call_id: "mc_1" })
export const finalFlushEvent = (sessionId: string, text: string): string => assistant(sessionId, text, {})
export const resultEvent = (sessionId: string, text: string, usage?: Record<string, number>): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, ...(usage ? { usage } : {}) })

export const replyLines = (sessionId: string, text: string): string[] => [
  initEvent(sessionId),
  deltaEvent(sessionId, text),
  finalFlushEvent(sessionId, text),
  resultEvent(sessionId, text),
]

export const toolReplyLines = (sessionId: string, calls: Array<{ name: string; arguments?: unknown }>, before = ""): string[] =>
  replyLines(sessionId, `${before}<{{marker}}>\n${JSON.stringify(calls)}\n</{{marker}}>`)
```

`test/helpers/fake-agent.ts`:

```typescript
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
```

- [ ] **Step 2: Write the failing tests**

`test/unit/error-classifier.test.ts`:

```typescript
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { classifyAgentFailure } from "../../src/cursor/error-classifier.js"

const classify = (stderr: string) => classifyAgentFailure({ stderr, exitCode: 1 })
const fixture = (name: string) => new URL(`../fixtures/agent/errors/${name}`, import.meta.url)

test("recognizes each documented failure", () => {
  const cases: Array<[string, number, string]> = [
    ["Error: You are not logged in. Run agent login.", 503, "service_unavailable"],
    ["Error: Invalid API key", 503, "service_unavailable"],
    ["You have reached your usage limit for this month", 429, "insufficient_quota"],
    ["Request failed with status 429: Too Many Requests", 429, "rate_limit_exceeded"],
    ["The prompt is too long: exceeds the maximum context length", 400, "context_length_exceeded"],
    ["Error: Unknown model 'no-such-model'", 404, "model_not_found"],
  ]
  for (const [stderr, status, code] of cases) {
    const error = classify(stderr)
    assert.equal(error.status, status, stderr)
    assert.equal(error.code, code, stderr)
    assert.equal(error.detail, stderr)
    assert.ok(!error.message.includes(stderr))
  }
})

test("anything else is an upstream error", () => {
  assert.equal(classify("segmentation fault").code, "upstream_error")
  assert.equal(classifyAgentFailure({ stderr: "", exitCode: null }).status, 502)
})

test("recorded Cursor samples are recognized", { skip: !existsSync(fixture("unknown-model.txt")) }, () => {
  assert.equal(classify(readFileSync(fixture("unknown-model.txt"), "utf8")).code, "model_not_found")
  const badKey = readFileSync(fixture("invalid-api-key.txt"), "utf8")
  if (badKey.trim()) assert.equal(classify(badKey).code, "service_unavailable")
})
```

`test/unit/agent-runner.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/cursor/error-classifier.js` and `src/cursor/agent-runner.js` cannot be found.

- [ ] **Step 4: Write the implementation**

`src/cursor/error-classifier.ts`:

```typescript
import { AdapterError } from "../openai/errors.js"

type Rule = { pattern: RegExp; build: (detail: string) => AdapterError }

// Cursor does not document its error codes. Patterns come from recorded samples in test/fixtures/agent/errors.
const RULES: Rule[] = [
  {
    pattern: /not logged in|login required|please log in|unauthori[sz]ed|authentication (failed|required)|invalid api key/i,
    build: (detail) => new AdapterError(503, "service_unavailable", "The Cursor CLI is not logged in", detail),
  },
  {
    pattern: /usage limit|spend(ing)? limit|quota|out of (fast )?requests|limit reached/i,
    build: (detail) => new AdapterError(429, "insufficient_quota", "Cursor usage limit reached", detail),
  },
  {
    pattern: /\b429\b|rate.?limit|too many requests/i,
    build: (detail) => new AdapterError(429, "rate_limit_exceeded", "Cursor rate limit reached", detail),
  },
  {
    pattern: /context (length|window)|too long|maximum context|prompt is too large|token limit/i,
    build: (detail) => new AdapterError(400, "context_length_exceeded", "The conversation is too long for this model", detail),
  },
  {
    pattern: /(unknown|invalid|unsupported) model|model .{0,80}not (found|available|supported)/i,
    build: (detail) => new AdapterError(404, "model_not_found", "Cursor does not recognize this model", detail),
  },
]

export const classifyAgentFailure = ({ stderr, exitCode }: { stderr: string; exitCode: number | null }): AdapterError => {
  for (const rule of RULES) if (rule.pattern.test(stderr)) return rule.build(stderr)
  return new AdapterError(
    502,
    "upstream_error",
    exitCode === null ? "The Cursor CLI stopped unexpectedly" : `The Cursor CLI failed with exit code ${exitCode}`,
    stderr,
  )
}
```

`src/cursor/agent-runner.ts`:

```typescript
import { spawn } from "node:child_process"
import { AdapterError } from "../openai/errors.js"
import { classifyAgentFailure } from "./error-classifier.js"

export type AgentUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }

export type AgentRunInput = {
  agentBin: string
  workspaceDir: string
  model: string
  prompt: string
  resumeSessionId?: string
  timeoutMs: number
  signal?: AbortSignal
  env: NodeJS.ProcessEnv
}

export type AgentRunResult = { sessionId?: string; resultText?: string; usage?: AgentUsage; deltaCount: number }

export class AgentAbortedError extends Error {
  constructor() {
    super("The client disconnected")
    this.name = "AgentAbortedError"
  }
}

type RawAgentEvent = {
  type?: string
  session_id?: unknown
  timestamp_ms?: unknown
  model_call_id?: unknown
  message?: { content?: Array<{ type?: string; text?: unknown }> }
  result?: unknown
  usage?: unknown
}

const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CURSOR_API_KEY"]

export const buildAgentEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" }
  for (const name of ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name]
  return env
}

export const buildAgentArgs = (input: { workspaceDir: string; model: string; resumeSessionId?: string }): string[] => {
  const args = [
    "--print", "--mode", "ask", "--trust", "--workspace", input.workspaceDir, "--model", input.model,
    "--output-format", "stream-json", "--stream-partial-output",
  ]
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId)
  return args
}

// With --stream-partial-output, only assistant events with timestamp_ms and without model_call_id carry new text.
const isNewText = (event: RawAgentEvent): boolean =>
  event.type === "assistant" && typeof event.timestamp_ms === "number" && event.model_call_id === undefined

export const createAgentStreamParser = (onText: (text: string) => void) => {
  const state: AgentRunResult = { deltaCount: 0 }
  let buffer = ""
  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: RawAgentEvent
    try {
      event = JSON.parse(trimmed) as RawAgentEvent
    } catch {
      return
    }
    if (typeof event.session_id === "string" && event.session_id) state.sessionId = event.session_id
    if (isNewText(event)) {
      const text = (event.message?.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("")
      if (text) {
        state.deltaCount += 1
        onText(text)
      }
    }
    if (event.type === "result") {
      if (typeof event.result === "string") state.resultText = event.result
      if (typeof event.usage === "object" && event.usage !== null) state.usage = event.usage as AgentUsage
    }
  }
  return {
    push(chunk: string): void {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
    },
    finish(): AgentRunResult {
      if (buffer) handleLine(buffer)
      buffer = ""
      return state
    },
  }
}

export const runAgent = (input: AgentRunInput, onText: (text: string) => void): Promise<AgentRunResult> =>
  new Promise((resolve, reject) => {
    if (input.model.startsWith("-")) {
      reject(new AdapterError(404, "model_not_found", `Unknown model: ${input.model}`))
      return
    }
    const child = spawn(input.agentBin, buildAgentArgs(input), {
      cwd: input.workspaceDir,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      // A separate process group lets the adapter stop agent and every process it started.
      detached: true,
    })
    const parser = createAgentStreamParser(onText)
    let stderr = ""
    let settled = false
    let stopReason: "timeout" | "aborted" | undefined

    const stopTree = (): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        return
      }
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          // The group has already exited.
        }
      }, 2000).unref()
    }
    const timer = setTimeout(() => {
      stopReason = "timeout"
      stopTree()
    }, input.timeoutMs)
    const onAbort = (): void => {
      stopReason = "aborted"
      stopTree()
    }
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      action()
    }

    input.signal?.addEventListener("abort", onAbort, { once: true })
    if (input.signal?.aborted) onAbort()

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => parser.push(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new AdapterError(503, "service_unavailable", "The Cursor CLI was not found", error.message)
            : new AdapterError(502, "upstream_error", "The Cursor CLI could not be started", error.message),
        ),
      )
    })
    child.on("close", (code) => {
      const state = parser.finish()
      finish(() => {
        if (stopReason === "timeout") reject(new AdapterError(504, "timeout", "The Cursor CLI took too long", stderr))
        else if (stopReason === "aborted") reject(new AgentAbortedError())
        else if (code !== 0) reject(classifyAgentFailure({ stderr, exitCode: code }))
        else resolve(state)
      })
    })
    child.stdin.on("error", () => undefined)
    child.stdin.end(input.prompt)
  })

export const runAgentCommand = (
  agentBin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(agentBin, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (error) => {
      stderr += error.message
      done(null)
    })
    child.on("close", (code) => done(code))
  })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass. If the "recorded Cursor samples" test fails, open the sample in `test/fixtures/agent/errors/`, add its wording to the pattern of the rule it belongs to in `RULES`, and run again.

- [ ] **Step 6: Commit**

```bash
git add src/cursor/error-classifier.ts src/cursor/agent-runner.ts test/helpers/agent-events.ts test/helpers/fake-agent.ts test/unit/error-classifier.test.ts test/unit/agent-runner.test.ts
git commit -m "feat: run the Cursor CLI with a clean environment and process-group stop"
```

---

### Task 13: Usage and model list

**Files:**
- Create: `src/cursor/usage.ts`, `src/cursor/model-list.ts`
- Test: `test/unit/usage.test.ts`, `test/unit/model-list.test.ts`

**Interfaces:**
- Consumes: `AgentUsage` (Task 12), `AdapterError`, `StartupError` (Task 2).
- Produces:
  - `CURSOR_USAGE_COVERS_CONVERSATION: boolean` (value decided in Task 1, step 3)
  - `type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }` (exported from `src/cursor/usage.ts`)
  - `toOpenAiUsage(usage: AgentUsage | undefined, coversConversation?: boolean): Usage | undefined`
  - `parseModelList(stdout: string): string[]`
  - `class ModelCatalog` with `constructor(options: { cacheFile: string; cacheMs: number; fetchList: () => Promise<string[]>; now?: () => number; onWarning?: (message: string) => void })`, `init(): Promise<void>` (throws `StartupError`), `list(): Promise<string[]>` (throws `AdapterError` 503), `has(model: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

`test/unit/usage.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { toOpenAiUsage } from "../../src/cursor/usage.js"

test("usage is omitted unless it covers the whole conversation", () => {
  assert.equal(toOpenAiUsage({ inputTokens: 10, outputTokens: 2 }, false), undefined)
  assert.equal(toOpenAiUsage(undefined, true), undefined)
  assert.equal(toOpenAiUsage({ outputTokens: 2 }, true), undefined)
})

test("prompt tokens include cached tokens", () => {
  assert.deepEqual(toOpenAiUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 5 }, true), {
    prompt_tokens: 115,
    completion_tokens: 2,
    total_tokens: 117,
  })
})
```

`test/unit/model-list.test.ts`:

```typescript
import assert from "node:assert/strict"
import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { ModelCatalog, parseModelList } from "../../src/cursor/model-list.js"
import { AdapterError } from "../../src/openai/errors.js"
import { StartupError } from "../../src/startup-error.js"
import { makeTempDir } from "../helpers/temp-dir.js"

let dir: { path: string; cleanup(): Promise<void> }
let cacheFile: string
beforeEach(async () => {
  dir = await makeTempDir()
  cacheFile = join(dir.path, "models-cache.json")
})
afterEach(() => dir.cleanup())

test("parses the agent --list-models output", () => {
  const output = "\u001b[1mAvailable models\u001b[0m\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\n- not a model\nTip: use --model <id>\n"
  assert.deepEqual(parseModelList(output), ["auto", "composer-2.5", "gpt-5.6-sol-high"])
})

test("init fetches the list, saves it privately, and has() checks exact names", async () => {
  const catalog = new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: async () => ["composer-2.5"] })
  await catalog.init()
  assert.equal(await catalog.has("composer-2.5"), true)
  assert.equal(await catalog.has("composer"), false)
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600)
})

test("init uses the saved list when fetching fails, and fails without one", async () => {
  const failing = async () => {
    throw new Error("offline")
  }
  await assert.rejects(new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: failing }).init(), StartupError)
  await writeFile(cacheFile, JSON.stringify({ ids: ["composer-2.5"] }))
  const warnings: string[] = []
  const catalog = new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: failing, onWarning: (message) => warnings.push(message) })
  await catalog.init()
  assert.deepEqual(await catalog.list(), ["composer-2.5"])
  assert.equal(warnings.length, 1)
})

test("list refreshes after the cache time and keeps the old list if a refresh fails", async () => {
  let now = 0
  let calls = 0
  let fail = false
  const catalog = new ModelCatalog({
    cacheFile,
    cacheMs: 1000,
    now: () => now,
    fetchList: async () => {
      calls += 1
      if (fail) throw new Error("offline")
      return [`model-${calls}`]
    },
  })
  await catalog.init()
  assert.deepEqual(await catalog.list(), ["model-1"])
  now = 1500
  assert.deepEqual(await catalog.list(), ["model-2"])
  fail = true
  now = 3000
  assert.deepEqual(await catalog.list(), ["model-2"])
})

test("list returns 503 when there has never been a list", async () => {
  const catalog = new ModelCatalog({ cacheFile, cacheMs: 1000, fetchList: async () => { throw new Error("offline") } })
  await assert.rejects(catalog.list(), (error: unknown) => error instanceof AdapterError && error.status === 503)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/cursor/usage.js` and `src/cursor/model-list.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/cursor/usage.ts` (set the constant to `true` only if Task 1, check 3 suggested it):

```typescript
import type { AgentUsage } from "./agent-runner.js"

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

// Set from pre-implementation check 3: true only if a resumed session reports usage for the whole conversation.
export const CURSOR_USAGE_COVERS_CONVERSATION = false

export const toOpenAiUsage = (usage: AgentUsage | undefined, coversConversation = CURSOR_USAGE_COVERS_CONVERSATION): Usage | undefined => {
  if (!coversConversation || !usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return undefined
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return { prompt_tokens: prompt, completion_tokens: usage.outputTokens, total_tokens: prompt + usage.outputTokens }
}
```

`src/cursor/model-list.ts`:

```typescript
import { readFile, rename, writeFile } from "node:fs/promises"
import { AdapterError } from "../openai/errors.js"
import { StartupError } from "../startup-error.js"

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export const parseModelList = (stdout: string): string[] => {
  const ids = new Set<string>()
  for (const line of stdout.replace(ANSI, "").split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/[\]=,-]*) - /.exec(line.trim())
    if (match) ids.add(match[1])
  }
  return [...ids]
}

export type ModelCatalogOptions = {
  cacheFile: string
  cacheMs: number
  fetchList: () => Promise<string[]>
  now?: () => number
  onWarning?: (message: string) => void
}

export class ModelCatalog {
  private ids: string[] = []
  private fetchedAt = 0
  private refreshing: Promise<void> | undefined

  constructor(private readonly options: ModelCatalogOptions) {}

  async init(): Promise<void> {
    try {
      await this.refresh()
    } catch (error) {
      if (!(await this.loadCache())) throw new StartupError(`Could not get the Cursor model list: ${(error as Error).message}`)
      this.options.onWarning?.("Using the saved model list because the Cursor CLI could not list models")
    }
  }

  async list(): Promise<string[]> {
    if (this.now() - this.fetchedAt >= this.options.cacheMs) {
      try {
        await this.refreshOnce()
      } catch {
        this.fetchedAt = this.now()
        if (this.ids.length === 0) throw new AdapterError(503, "service_unavailable", "The Cursor model list is unavailable")
      }
    }
    return this.ids
  }

  async has(model: string): Promise<boolean> {
    return (await this.list()).includes(model)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private refreshOnce(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(): Promise<void> {
    const ids = await this.options.fetchList()
    if (ids.length === 0) throw new Error("the Cursor CLI returned no models")
    this.ids = ids
    this.fetchedAt = this.now()
    const temp = `${this.options.cacheFile}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ ids }), { mode: 0o600 })
    await rename(temp, this.options.cacheFile)
  }

  private async loadCache(): Promise<boolean> {
    try {
      const data = JSON.parse(await readFile(this.options.cacheFile, "utf8")) as { ids?: unknown }
      if (Array.isArray(data.ids) && data.ids.length > 0 && data.ids.every((id) => typeof id === "string")) {
        this.ids = data.ids
        this.fetchedAt = this.now()
        return true
      }
    } catch {
      // No usable saved list.
    }
    return false
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cursor/usage.ts src/cursor/model-list.ts test/unit/usage.test.ts test/unit/model-list.test.ts
git commit -m "feat: add usage mapping and cached model list"
```

---

### Task 14: Response writer

**Files:**
- Create: `src/openai/response-writer.ts`, `test/helpers/http.ts`
- Test: `test/unit/response-writer.test.ts`

**Interfaces:**
- Consumes: `AdapterError`, `errorBody`, `ChatToolCall` (Task 2), `Usage` (Task 13).
- Produces:
  - `type FinishReason = "stop" | "tool_calls"`, `type ResponseMeta = { id: string; created: number; model: string }`
  - `createResponseMeta(model: string): ResponseMeta`, `createToolCallId(): string` (`call_` plus 24 hex characters)
  - `completionBody(meta: ResponseMeta, input: { content: string; toolCalls: ChatToolCall[]; finishReason: FinishReason; usage?: Usage }): object`
  - `sendJson(res: ServerResponse, status: number, body: unknown): void`, `sendError(res: ServerResponse, error: AdapterError): void`
  - `class SseWriter` with `constructor(res: ServerResponse, meta: ResponseMeta)`, `hasStarted: boolean`, `text(text: string): void`, `toolCalls(calls: ChatToolCall[]): void`, `finish(reason: FinishReason, usage: Usage | undefined, includeUsage: boolean): void`, `error(error: AdapterError): void`
  - Test helpers: `startServer(handler): Promise<{ url: string; close(): Promise<void> }>`, `parseSse(text: string): unknown[]` (`"[DONE]"` for the end marker)

- [ ] **Step 1: Write the test helper and the failing tests**

`test/helpers/http.ts`:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const startServer = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> => {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export const parseSse = (text: string): unknown[] =>
  text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length))
    .map((data) => (data === "[DONE]" ? "[DONE]" : JSON.parse(data)))
```

`test/unit/response-writer.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { AdapterError } from "../../src/openai/errors.js"
import { completionBody, createResponseMeta, createToolCallId, SseWriter } from "../../src/openai/response-writer.js"
import { parseSse, startServer } from "../helpers/http.js"

const meta = { id: "chatcmpl-1", created: 100, model: "composer-2.5" }
const call = { id: "call_1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }

test("IDs use the OpenAI formats", () => {
  assert.match(createToolCallId(), /^call_[0-9a-f]{24}$/)
  assert.match(createResponseMeta("m").id, /^chatcmpl-[0-9a-f]{24}$/)
})

test("completionBody builds a chat.completion object", () => {
  assert.deepEqual(completionBody(meta, { content: "", toolCalls: [call], finishReason: "tool_calls" }), {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 100,
    model: "composer-2.5",
    choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [call] }, finish_reason: "tool_calls" }],
  })
  const withUsage = completionBody(meta, { content: "hi", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  assert.deepEqual((withUsage as { usage: unknown }).usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  assert.ok(!("tool_calls" in (withUsage as { choices: Array<{ message: object }> }).choices[0].message))
})

const stream = async (write: (writer: SseWriter) => void) => {
  const server = await startServer((_req, res) => write(new SseWriter(res, meta)))
  try {
    const response = await fetch(server.url)
    return { status: response.status, type: response.headers.get("content-type"), events: parseSse(await response.text()) }
  } finally {
    await server.close()
  }
}

test("streams text, tool calls, finish, usage, and the end marker", async () => {
  const result = await stream((writer) => {
    writer.text("Hel")
    writer.text("lo")
    writer.toolCalls([call])
    writer.finish("tool_calls", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, true)
  })
  assert.equal(result.status, 200)
  assert.match(result.type ?? "", /text\/event-stream/)
  const deltas = result.events.slice(0, 4).map((event) => (event as { choices: Array<{ delta: unknown; finish_reason: unknown }> }).choices[0])
  assert.deepEqual(deltas[0], { index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null })
  assert.deepEqual(deltas[1], { index: 0, delta: { content: "lo" }, finish_reason: null })
  assert.deepEqual(deltas[2], { index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null })
  assert.deepEqual(deltas[3], { index: 0, delta: {}, finish_reason: "tool_calls" })
  assert.deepEqual(result.events[4], { id: "chatcmpl-1", object: "chat.completion.chunk", created: 100, model: "composer-2.5", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
  assert.equal(result.events[5], "[DONE]")
})

test("the usage chunk is left out when not requested or not available", async () => {
  const notRequested = await stream((writer) => writer.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, false))
  assert.equal(notRequested.events.length, 2)
  const unavailable = await stream((writer) => writer.finish("stop", undefined, true))
  assert.equal(unavailable.events.length, 2)
  assert.deepEqual((unavailable.events[0] as { choices: Array<{ delta: unknown }> }).choices[0].delta, { role: "assistant" })
})

test("an error after streaming started is sent as an event", async () => {
  const result = await stream((writer) => {
    writer.text("partial")
    writer.error(new AdapterError(504, "timeout", "The Cursor CLI took too long"))
  })
  assert.deepEqual(result.events[1], { error: { message: "The Cursor CLI took too long", type: "timeout", code: "timeout" } })
  assert.equal(result.events[2], "[DONE]")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/openai/response-writer.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/openai/response-writer.ts`:

```typescript
import { randomBytes } from "node:crypto"
import type { ServerResponse } from "node:http"
import type { Usage } from "../cursor/usage.js"
import { type AdapterError, errorBody } from "./errors.js"
import type { ChatToolCall } from "./types.js"

export type FinishReason = "stop" | "tool_calls"
export type ResponseMeta = { id: string; created: number; model: string }

export const createResponseMeta = (model: string): ResponseMeta => ({
  id: `chatcmpl-${randomBytes(12).toString("hex")}`,
  created: Math.floor(Date.now() / 1000),
  model,
})

export const createToolCallId = (): string => `call_${randomBytes(12).toString("hex")}`

export const completionBody = (
  meta: ResponseMeta,
  input: { content: string; toolCalls: ChatToolCall[]; finishReason: FinishReason; usage?: Usage },
) => ({
  id: meta.id,
  object: "chat.completion",
  created: meta.created,
  model: meta.model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: input.content, ...(input.toolCalls.length > 0 ? { tool_calls: input.toolCalls } : {}) },
      finish_reason: input.finishReason,
    },
  ],
  ...(input.usage ? { usage: input.usage } : {}),
})

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

export const sendError = (res: ServerResponse, error: AdapterError): void => sendJson(res, error.status, errorBody(error))

export class SseWriter {
  private started = false
  private roleSent = false

  constructor(
    private readonly res: ServerResponse,
    private readonly meta: ResponseMeta,
  ) {}

  get hasStarted(): boolean {
    return this.started
  }

  text(text: string): void {
    if (text) this.chunk({ content: text })
  }

  toolCalls(calls: ChatToolCall[]): void {
    calls.forEach((call, index) => {
      this.chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] })
    })
  }

  finish(reason: FinishReason, usage: Usage | undefined, includeUsage: boolean): void {
    this.chunk({}, reason)
    if (includeUsage && usage) this.write({ ...this.envelope(), choices: [], usage })
    this.res.end("data: [DONE]\n\n")
  }

  error(error: AdapterError): void {
    this.write(errorBody(error))
    this.res.end("data: [DONE]\n\n")
  }

  private envelope() {
    return { id: this.meta.id, object: "chat.completion.chunk", created: this.meta.created, model: this.meta.model }
  }

  private chunk(delta: Record<string, unknown>, finishReason: FinishReason | null = null): void {
    const fullDelta = this.roleSent ? delta : { role: "assistant", ...delta }
    this.roleSent = true
    this.write({ ...this.envelope(), choices: [{ index: 0, delta: fullDelta, finish_reason: finishReason }] })
  }

  private write(data: unknown): void {
    if (!this.started) {
      this.res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" })
      this.started = true
    }
    this.res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/openai/response-writer.ts test/helpers/http.ts test/unit/response-writer.test.ts
git commit -m "feat: write OpenAI JSON and streamed responses"
```

---

### Task 15: Request queue and logging

**Files:**
- Create: `src/concurrency.ts`, `src/log.ts`
- Test: `test/unit/concurrency.test.ts`, `test/unit/log.test.ts`

**Interfaces:**
- Consumes: `AdapterError` (Task 2).
- Produces:
  - `class RequestQueue` with `constructor(options: { maxConcurrent: number; maxQueued: number; queueTimeoutMs: number })` and `acquire(): Promise<() => void>` (throws `AdapterError` 503 `server_busy`; the returned release function is safe to call twice)
  - `type RequestLogEntry = { requestId: string; model: string; mode?: "fresh" | "continued"; freshReason?: "new" | "no-match" | "resume-failed"; status: number; errorClass?: string; durationMs: number; adapterMs?: number; promptChars?: number; fullPromptChars?: number; promptTokens?: number; completionTokens?: number; droppedChars?: number; invalidToolBlock?: string; recorded?: boolean }`
  - `type Logger = { request(entry: RequestLogEntry): void; info(message: string): void; warn(message: string): void; agentOutput(requestId: string, output: string): void }`
  - `createLogger(options: { debugAgentOutput: boolean; write?: (line: string) => void; now?: () => Date }): Logger`

- [ ] **Step 1: Write the failing tests**

`test/unit/concurrency.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { RequestQueue } from "../../src/concurrency.js"
import { AdapterError } from "../../src/openai/errors.js"

const busy = (error: unknown) => error instanceof AdapterError && error.status === 503 && error.code === "server_busy"

test("waiting requests get a slot when one is released", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1000 })
  const release = await queue.acquire()
  let acquired = false
  const waiting = queue.acquire().then((next) => {
    acquired = true
    return next
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(acquired, false)
  release()
  release()
  const next = await waiting
  assert.equal(acquired, true)
  next()
})

test("a full queue rejects at once", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 1000 })
  const release = await queue.acquire()
  await assert.rejects(queue.acquire(), busy)
  release()
})

test("a request that waits too long is rejected", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 50 })
  const release = await queue.acquire()
  await assert.rejects(queue.acquire(), busy)
  release()
  const again = await queue.acquire()
  again()
})
```

`test/unit/log.test.ts`:

```typescript
import assert from "node:assert/strict"
import { test } from "node:test"
import { createLogger } from "../../src/log.js"

const capture = (debugAgentOutput: boolean) => {
  const lines: string[] = []
  const logger = createLogger({ debugAgentOutput, write: (line) => lines.push(line), now: () => new Date("2026-09-25T00:00:00Z") })
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) }
}

test("request entries are single JSON lines with metadata only", () => {
  const { logger, parsed } = capture(false)
  logger.request({ requestId: "r1", model: "composer-2.5", mode: "continued", status: 200, durationMs: 12 })
  assert.deepEqual(parsed()[0], { time: "2026-09-25T00:00:00.000Z", level: "info", event: "request", requestId: "r1", model: "composer-2.5", mode: "continued", status: 200, durationMs: 12 })
})

test("agent output is logged only in debug mode, cut to 2000 characters", () => {
  const off = capture(false)
  off.logger.agentOutput("r1", "secret prompt text")
  assert.equal(off.lines.length, 0)
  const on = capture(true)
  on.logger.agentOutput("r1", "x".repeat(3000))
  assert.equal((on.parsed()[0].output as string).length, 2000)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/concurrency.js` and `src/log.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/concurrency.ts`:

```typescript
import { AdapterError } from "./openai/errors.js"

export type QueueOptions = { maxConcurrent: number; maxQueued: number; queueTimeoutMs: number }

const busy = (): AdapterError => new AdapterError(503, "server_busy", "The adapter is busy; try again shortly")

export class RequestQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly options: QueueOptions) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1
      return this.releaser()
    }
    if (this.waiting.length >= this.options.maxQueued) throw busy()
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const position = this.waiting.indexOf(grant)
        if (position !== -1) this.waiting.splice(position, 1)
        reject(busy())
      }, this.options.queueTimeoutMs)
      this.waiting.push(grant)
    })
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}
```

`src/log.ts`:

```typescript
export type RequestLogEntry = {
  requestId: string
  model: string
  mode?: "fresh" | "continued"
  freshReason?: "new" | "no-match" | "resume-failed"
  status: number
  errorClass?: string
  durationMs: number
  adapterMs?: number
  promptChars?: number
  fullPromptChars?: number
  promptTokens?: number
  completionTokens?: number
  droppedChars?: number
  invalidToolBlock?: string
  recorded?: boolean
}

export type Logger = {
  request(entry: RequestLogEntry): void
  info(message: string): void
  warn(message: string): void
  agentOutput(requestId: string, output: string): void
}

export const createLogger = (options: { debugAgentOutput: boolean; write?: (line: string) => void; now?: () => Date }): Logger => {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
  const emit = (level: string, fields: Record<string, unknown>): void =>
    write(JSON.stringify({ time: (options.now?.() ?? new Date()).toISOString(), level, ...fields }))
  return {
    request: (entry) => emit("info", { event: "request", ...entry }),
    info: (message) => emit("info", { message }),
    warn: (message) => emit("warn", { message }),
    agentOutput: (requestId, output) => {
      if (options.debugAgentOutput) emit("debug", { event: "agent_output", requestId, output: output.slice(0, 2000) })
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/concurrency.ts src/log.ts test/unit/concurrency.test.ts test/unit/log.test.ts
git commit -m "feat: add request queue and metadata logging"
```

---

### Task 16: Chat request handler

**Files:**
- Create: `src/openai/chat-completions.ts`
- Test: `test/unit/chat-completions.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4 to 15.
- Produces:
  - `CONVERSATION_HEADER = "x-cursor2openai-conversation"`
  - `type ChatDeps = { defaultModel: string; agentBin: string; workspaceDir: string; requestTimeoutMs: number; agentEnv: NodeJS.ProcessEnv; index: Pick<ConversationIndex, "take" | "add">; models: Pick<ModelCatalog, "has">; logger: Logger; runAgent: (input: AgentRunInput, onText: (text: string) => void) => Promise<AgentRunResult>; prepareRun: () => Promise<void>; trackRequest?: (controller: AbortController) => () => void; usageCoversConversation?: boolean; now?: () => number }`
  - `handleChatCompletions(req: IncomingMessage, res: ServerResponse, body: unknown, deps: ChatDeps): Promise<void>` (never throws; writes the response and one log entry)

- [ ] **Step 1: Write the failing tests**

`test/unit/chat-completions.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/openai/chat-completions.js` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/openai/chat-completions.ts`:

```typescript
import { randomBytes } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ConversationIndex, IndexEntry } from "../conversation/conversation-index.js"
import { type Controls, conversationKey, lastAssistantIndex } from "../conversation/fingerprint.js"
import { AgentAbortedError, type AgentRunInput, type AgentRunResult } from "../cursor/agent-runner.js"
import type { ModelCatalog } from "../cursor/model-list.js"
import { toOpenAiUsage } from "../cursor/usage.js"
import { saveImages } from "../images/attachments.js"
import type { Logger, RequestLogEntry } from "../log.js"
import { buildContinuedPrompt, buildFullPrompt, stripCodeFences, toolsActive } from "../prompt/prompt-builder.js"
import { type SplitterEvent, StreamSplitter } from "../prompt/stream-splitter.js"
import { createMarker, type ParsedToolCall } from "../prompt/tool-protocol.js"
import { AdapterError } from "./errors.js"
import { isJsonFormat, normalizeRequest } from "./request-contract.js"
import { completionBody, createResponseMeta, createToolCallId, sendError, sendJson, SseWriter } from "./response-writer.js"
import type { ChatMessage, ChatToolCall } from "./types.js"

export const CONVERSATION_HEADER = "x-cursor2openai-conversation"

export type ChatDeps = {
  defaultModel: string
  agentBin: string
  workspaceDir: string
  requestTimeoutMs: number
  agentEnv: NodeJS.ProcessEnv
  index: Pick<ConversationIndex, "take" | "add">
  models: Pick<ModelCatalog, "has">
  logger: Logger
  runAgent: (input: AgentRunInput, onText: (text: string) => void) => Promise<AgentRunResult>
  prepareRun: () => Promise<void>
  trackRequest?: (controller: AbortController) => () => void
  usageCoversConversation?: boolean
  now?: () => number
}

type Attempt = {
  text: string
  calls: ParsedToolCall[]
  result: AgentRunResult
  marker: string
  promptChars: number
  fullPromptChars: number
  droppedChars: number
  invalidToolBlock?: string
}

const headerValue = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value)?.trim() ?? ""

export const handleChatCompletions = async (req: IncomingMessage, res: ServerResponse, body: unknown, deps: ChatDeps): Promise<void> => {
  const now = deps.now ?? Date.now
  const started = now()
  const requestId = randomBytes(8).toString("hex")
  const log: RequestLogEntry = { requestId, model: "", status: 200, durationMs: 0 }
  const controller = new AbortController()
  const untrack = deps.trackRequest?.(controller)
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort()
  }
  res.on("close", onClose)
  let sse: SseWriter | undefined
  let agentMs = 0

  try {
    const request = normalizeRequest(body, deps.defaultModel)
    log.model = request.model
    if (!(await deps.models.has(request.model))) throw new AdapterError(404, "model_not_found", `Unknown model: ${request.model}`)

    const controls: Controls = { toolChoice: request.toolChoice, parallelToolCalls: request.parallelToolCalls, responseFormat: request.responseFormat }
    const keyBase = { affinity: headerValue(req.headers[CONVERSATION_HEADER]), model: request.model, tools: request.tools, controls }
    const lastAssistant = lastAssistantIndex(request.messages)
    const entry =
      lastAssistant >= 0
        ? await deps.index.take(conversationKey({ ...keyBase, messages: request.messages.slice(0, lastAssistant + 1) }))
        : undefined
    log.mode = entry ? "continued" : "fresh"
    if (!entry) log.freshReason = lastAssistant >= 0 ? "no-match" : "new"

    await deps.prepareRun()
    const json = isJsonFormat(request.responseFormat)
    const meta = createResponseMeta(request.model)
    if (request.stream) sse = new SseWriter(res, meta)
    let sentText = false

    const runAttempt = async (resume: IndexEntry | undefined): Promise<Attempt> => {
      const marker = resume?.marker ?? createMarker()
      const fromIndex = resume ? lastAssistant + 1 : 0
      const images = await saveImages({
        workspaceDir: deps.workspaceDir,
        requestId: `${requestId}-${resume ? "continued" : "fresh"}`,
        messages: request.messages,
        fromIndex,
      })
      try {
        const prompt = resume ? buildContinuedPrompt(request, fromIndex, marker, images.paths) : buildFullPrompt(request, marker, images.paths)
        const splitter = new StreamSplitter(toolsActive(request) ? marker : undefined)
        let text = ""
        let calls: ParsedToolCall[] = []
        const apply = (events: SplitterEvent[]): void => {
          for (const event of events) {
            if (event.type === "tool_calls") {
              calls = event.calls
              continue
            }
            text += event.text
            if (sse && !json) {
              sse.text(event.text)
              sentText = true
            }
          }
        }
        const agentStarted = now()
        const result = await deps.runAgent(
          {
            agentBin: deps.agentBin,
            workspaceDir: deps.workspaceDir,
            model: request.model,
            prompt,
            resumeSessionId: resume?.sessionId,
            timeoutMs: deps.requestTimeoutMs,
            signal: controller.signal,
            env: deps.agentEnv,
          },
          (chunk) => apply(splitter.push(chunk)),
        )
        agentMs += now() - agentStarted
        if (result.deltaCount === 0 && result.resultText) apply(splitter.push(result.resultText))
        const end = splitter.end()
        apply(end.events)
        return {
          text,
          calls,
          result,
          marker,
          promptChars: prompt.length,
          fullPromptChars: resume ? buildFullPrompt(request, marker, new Map()).length : prompt.length,
          droppedChars: end.summary.droppedChars,
          invalidToolBlock: end.summary.invalidBlockReason,
        }
      } finally {
        await images.cleanup()
      }
    }

    let attempt: Attempt
    try {
      attempt = await runAttempt(entry)
    } catch (error) {
      if (!(entry && error instanceof AdapterError && error.code === "upstream_error" && !sentText && !controller.signal.aborted)) throw error
      if (error.detail) deps.logger.agentOutput(requestId, error.detail)
      log.mode = "fresh"
      log.freshReason = "resume-failed"
      attempt = await runAttempt(undefined)
    }

    const content = json ? stripCodeFences(attempt.text) : attempt.text
    let toolCalls: ChatToolCall[] = attempt.calls.map((call) => ({
      id: createToolCallId(),
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }))
    const trimmed = !request.parallelToolCalls && toolCalls.length > 1
    if (trimmed) toolCalls = toolCalls.slice(0, 1)
    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"
    const usage = toOpenAiUsage(attempt.result.usage, deps.usageCoversConversation)

    if (sse) {
      if (json && content) sse.text(content)
      if (toolCalls.length > 0) sse.toolCalls(toolCalls)
      sse.finish(finishReason, usage, request.includeUsage)
    } else {
      sendJson(res, 200, completionBody(meta, { content, toolCalls, finishReason, usage }))
    }

    const sessionId = attempt.result.sessionId
    const recorded = !trimmed && sessionId !== undefined
    if (recorded && sessionId !== undefined) {
      const replyMessage: ChatMessage = { role: "assistant", content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }
      deps.index.add(conversationKey({ ...keyBase, messages: [...request.messages, replyMessage] }), { sessionId, marker: attempt.marker })
    }
    Object.assign(log, {
      promptChars: attempt.promptChars,
      fullPromptChars: attempt.fullPromptChars,
      droppedChars: attempt.droppedChars || undefined,
      invalidToolBlock: attempt.invalidToolBlock,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      recorded,
    })
  } catch (error) {
    if (error instanceof AgentAbortedError || controller.signal.aborted) {
      log.status = 499
      log.errorClass = "client_disconnected"
      return
    }
    const failure = error instanceof AdapterError ? error : new AdapterError(500, "internal_error", "Internal adapter error")
    if (!(error instanceof AdapterError)) deps.logger.warn(`Internal error in request ${requestId}: ${(error as Error).message}`)
    if (failure.detail) deps.logger.agentOutput(requestId, failure.detail)
    log.status = failure.status
    log.errorClass = failure.code
    if (sse?.hasStarted) sse.error(failure)
    else if (!res.headersSent) sendError(res, failure)
  } finally {
    res.off("close", onClose)
    untrack?.()
    log.durationMs = now() - started
    log.adapterMs = log.durationMs - agentMs
    deps.logger.request(log)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/openai/chat-completions.ts test/unit/chat-completions.test.ts
git commit -m "feat: handle chat completions with session continuation"
```

---

### Task 17: HTTP server and end-to-end integration tests

**Files:**
- Create: `src/server.ts`, `test/helpers/adapter-harness.ts`
- Test: `test/integration/server.test.ts`

**Interfaces:**
- Consumes: `handleChatCompletions`, `ChatDeps`, `CONVERSATION_HEADER` (Task 16), `RequestQueue` (Task 15), `ModelCatalog` (Task 13), `AdapterError`, response helpers (Tasks 2 and 14), and for the harness: `prepareWorkspace`, `ensureWorkspaceReady` (Task 11), `runAgent`, `runAgentCommand`, `buildAgentEnv` (Task 12), `ConversationIndex` (Task 5), fake agent helpers (Task 12).
- Produces:
  - `type ServerOptions = { apiKey: string; maxBodyBytes: number; queue: Pick<RequestQueue, "acquire">; models: Pick<ModelCatalog, "has" | "list">; chat: Omit<ChatDeps, "models" | "trackRequest">; tls?: { cert: Buffer; key: Buffer }; timeouts?: { headersMs?: number; requestMs?: number; keepAliveMs?: number; checkIntervalMs?: number } }`
  - `type AdapterServer = { server: http.Server; listen(port: number, host: string): Promise<number>; shutdown(graceMs: number): Promise<void> }`
  - `isAuthorized(header: string | undefined, apiKey: string): boolean`
  - `readJsonBody(req: IncomingMessage, limit: number): Promise<unknown>`
  - `createAdapterServer(options: ServerOptions): AdapterServer`
  - Test helper: `API_KEY`, `startAdapter(options: HarnessOptions): Promise<Harness>` with `Harness = { url; port; dir; agent; workspaceDir; indexFile; logs; permissionsText; post(body, init?): Promise<Response>; stop(): Promise<void> }`

- [ ] **Step 1: Write the test harness**

`test/helpers/adapter-harness.ts`:

```typescript
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
```

- [ ] **Step 2: Write the failing integration tests**

`test/integration/server.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/server.js` cannot be found.

- [ ] **Step 4: Write the implementation**

`src/server.ts`:

```typescript
import { createHash, timingSafeEqual } from "node:crypto"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import type { RequestQueue } from "./concurrency.js"
import type { ModelCatalog } from "./cursor/model-list.js"
import { type ChatDeps, handleChatCompletions } from "./openai/chat-completions.js"
import { AdapterError } from "./openai/errors.js"
import { sendError, sendJson } from "./openai/response-writer.js"

export type ServerOptions = {
  apiKey: string
  maxBodyBytes: number
  queue: Pick<RequestQueue, "acquire">
  models: Pick<ModelCatalog, "has" | "list">
  chat: Omit<ChatDeps, "models" | "trackRequest">
  tls?: { cert: Buffer; key: Buffer }
  timeouts?: { headersMs?: number; requestMs?: number; keepAliveMs?: number; checkIntervalMs?: number }
}

export type AdapterServer = {
  server: http.Server
  listen(port: number, host: string): Promise<number>
  shutdown(graceMs: number): Promise<void>
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest()

export const isAuthorized = (header: string | undefined, apiKey: string): boolean => {
  const match = /^Bearer (.+)$/.exec(header ?? "")
  return match !== null && timingSafeEqual(digest(match[1]), digest(apiKey))
}

const tooLarge = (): AdapterError => new AdapterError(413, "request_too_large", "The request body is too large")
const methodNotAllowed = (): AdapterError => new AdapterError(405, "method_not_allowed", "Method not allowed")

export const readJsonBody = (req: IncomingMessage, limit: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"])
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on("end", () => {
      if (size > limit) {
        reject(tooLarge())
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new AdapterError(400, "invalid_request_error", "The request body is not valid JSON"))
      }
    })
    req.on("error", reject)
  })

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const createAdapterServer = (options: ServerOptions): AdapterServer => {
  const active = new Set<AbortController>()
  const chat: ChatDeps = {
    ...options.chat,
    models: options.models,
    trackRequest: (controller) => {
      active.add(controller)
      return () => active.delete(controller)
    },
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (req.method === "OPTIONS") throw methodNotAllowed()
    if (!isAuthorized(req.headers.authorization, options.apiKey)) throw new AdapterError(401, "invalid_api_key", "Invalid API key")
    if (path === "/v1/models") {
      if (req.method !== "GET") throw methodNotAllowed()
      const created = Math.floor(Date.now() / 1000)
      const ids = await options.models.list()
      sendJson(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created, owned_by: "cursor" })) })
      return
    }
    if (path !== "/v1/chat/completions") throw new AdapterError(404, "not_found", "Not found")
    if (req.method !== "POST") throw methodNotAllowed()
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      throw new AdapterError(400, "invalid_request_error", "Content-Type must be application/json")
    }
    const body = await readJsonBody(req, options.maxBodyBytes)
    const release = await options.queue.acquire()
    try {
      await handleChatCompletions(req, res, body, chat)
    } finally {
      release()
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((error: unknown) => {
      const failure = error instanceof AdapterError ? error : new AdapterError(500, "internal_error", "Internal adapter error")
      if (failure.status === 413) res.setHeader("connection", "close")
      if (!res.headersSent) sendError(res, failure)
      else res.end()
      req.resume()
    })
  }

  const serverOptions = { connectionsCheckingInterval: options.timeouts?.checkIntervalMs ?? 1000 }
  const server: http.Server = options.tls
    ? https.createServer({ ...serverOptions, cert: options.tls.cert, key: options.tls.key }, handler)
    : http.createServer(serverOptions, handler)
  server.headersTimeout = options.timeouts?.headersMs ?? 10_000
  server.requestTimeout = options.timeouts?.requestMs ?? 60_000
  server.keepAliveTimeout = options.timeouts?.keepAliveMs ?? 5_000

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          server.off("error", reject)
          resolve((server.address() as AddressInfo).port)
        })
      }),
    shutdown: async (graceMs) => {
      server.close()
      server.closeIdleConnections()
      const deadline = Date.now() + graceMs
      while (active.size > 0 && Date.now() < deadline) await delay(50)
      for (const controller of active) controller.abort()
      const hardDeadline = Date.now() + 5000
      while (active.size > 0 && Date.now() < hardDeadline) await delay(50)
      server.closeAllConnections()
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass (the HTTPS test is skipped only when `openssl` is not installed).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/helpers/adapter-harness.ts test/integration/server.test.ts
git commit -m "feat: add HTTP(S) server with auth, limits, and shutdown"
```

---

### Task 18: Startup checks and the entry point

**Files:**
- Create: `src/startup.ts`, `src/cli.ts`
- Test: `test/unit/startup.test.ts`, `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: `Config`, `loadConfig`, `isLoopback` (Task 3), `prepareWorkspace`, `ensureWorkspaceReady` (Task 11), `runAgent`, `runAgentCommand`, `buildAgentEnv` (Task 12), `ModelCatalog`, `parseModelList` (Task 13), `RequestQueue`, `createLogger` (Task 15), `ConversationIndex` (Task 5), `createAdapterServer` (Task 17), `StartupError` (Task 2).
- Produces:
  - `type StartupDeps = { config: Config; home: string; realHome: string; platform: NodeJS.Platform; uid: number; agentEnv: NodeJS.ProcessEnv; runCommand: typeof runAgentCommand }`
  - `runStartupChecks(deps: StartupDeps): Promise<{ permissionsText: string }>` (spec startup checks 3 to 10; checks 1 and 2 are in `loadConfig`, check 11 is `ModelCatalog.init`)
  - The `cursor2openai` command.

- [ ] **Step 1: Write the failing tests**

`test/unit/startup.test.ts`:

```typescript
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
```

`test/integration/cli.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL because `src/startup.js` and `src/cli.ts` cannot be found.

- [ ] **Step 3: Write the implementation**

`src/startup.ts`:

```typescript
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
```

`src/cli.ts`:

```typescript
#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { RequestQueue } from "./concurrency.js"
import { isLoopback, loadConfig } from "./config.js"
import { ConversationIndex } from "./conversation/conversation-index.js"
import { buildAgentEnv, runAgent, runAgentCommand } from "./cursor/agent-runner.js"
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
```

- [ ] **Step 4: Run the tests, type check, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass; `dist/cli.js` exists and starts with `#!/usr/bin/env node`.

- [ ] **Step 5: Commit**

```bash
git add src/startup.ts src/cli.ts test/unit/startup.test.ts test/integration/cli.test.ts
git commit -m "feat: add startup checks and the cursor2openai command"
```

---

### Task 19: Performance measurements and OpenAI SDK compatibility

**Files:**
- Create: `test/performance/adapter-overhead.test.ts`, `test/integration/openai-python-sdk.test.ts`

**Interfaces:**
- Consumes: `startAdapter`, `API_KEY` (Task 17), agent event helpers (Task 12).
- Produces: `npm run test:perf` results for spec section 13; an optional compatibility test that runs when `C2O_PYTHON` points to a Python with the `openai` package (for example `~/.hermes/hermes-agent/venv/bin/python`).

- [ ] **Step 1: Write the tests**

`test/performance/adapter-overhead.test.ts`:

```typescript
import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { type Harness, startAdapter } from "../helpers/adapter-harness.js"
import { deltaEvent, initEvent, replyLines, resultEvent } from "../helpers/agent-events.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
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

test("the adapter adds under 10 ms per request, excluding agent start", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: replyLines("s1", "Hello") }] })
  let messages: unknown[] = [{ role: "user", content: "hi" }]
  for (let i = 0; i < 30; i += 1) {
    const body = (await (await harness.post({ messages })).json()) as any
    messages = [...messages, { role: "assistant", content: body.choices[0].message.content }, { role: "user", content: `next ${i}` }]
  }
  const adapterMs = harness.logs.map((entry) => entry.adapterMs ?? Number.POSITIVE_INFINITY)
  const continued = harness.logs.filter((entry) => entry.mode === "continued").length
  console.log(`adapterMs median ${median(adapterMs)} ms, continued ${continued}/${harness.logs.length - 1}`)
  assert.ok(median(adapterMs) < 10)
})

test("streamed text reaches the client within 5 ms of leaving agent", async () => {
  const lines = [initEvent("s1"), ...Array.from({ length: 20 }, () => deltaEvent("s1", "T{{now}};")), resultEvent("s1", "")]
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines, lineDelayMs: 20 }] })
  const response = await harness.post({ messages: [{ role: "user", content: "hi" }], stream: true })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const delays: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const received = Date.now()
    for (const match of decoder.decode(value, { stream: true }).matchAll(/T(\d+);/g)) delays.push(received - Number(match[1]))
  }
  console.log(`relay delay median ${median(delays)} ms over ${delays.length} chunks`)
  assert.ok(delays.length >= 20)
  assert.ok(median(delays) < 5)
})
```

`test/integration/openai-python-sdk.test.ts`:

```typescript
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { afterEach, beforeEach, test } from "node:test"
import { promisify } from "node:util"
import { API_KEY, type Harness, startAdapter } from "../helpers/adapter-harness.js"
import { toolReplyLines } from "../helpers/agent-events.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const python = process.env.C2O_PYTHON
const run = promisify(execFile)
const SCRIPT = `
import json, sys
from openai import OpenAI
client = OpenAI(base_url=sys.argv[1] + "/v1", api_key=sys.argv[2])
stream = client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "Read a.md"}],
    tools=[{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}],
    stream=True,
    stream_options={"include_usage": True},
)
text, calls, finish = "", {}, None
for chunk in stream:
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta
    if delta.content:
        text += delta.content
    for call in delta.tool_calls or []:
        entry = calls.setdefault(call.index, {"id": "", "name": "", "arguments": ""})
        entry["id"] += call.id or ""
        if call.function:
            entry["name"] += call.function.name or ""
            entry["arguments"] += call.function.arguments or ""
    finish = chunk.choices[0].finish_reason or finish
print(json.dumps({"text": text, "calls": list(calls.values()), "finish": finish}))
`

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

test("the official OpenAI Python SDK parses streamed text and tool calls", { skip: !python }, async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: toolReplyLines("s1", [{ name: "read_file", arguments: { path: "a.md" } }], "Checking.\n") }] })
  const { stdout } = await run(python!, ["-c", SCRIPT, harness.url, API_KEY])
  const result = JSON.parse(stdout) as { text: string; finish: string; calls: Array<{ id: string; name: string; arguments: string }> }
  assert.equal(result.text, "Checking.\n")
  assert.equal(result.finish, "tool_calls")
  assert.equal(result.calls[0].name, "read_file")
  assert.match(result.calls[0].id, /^call_[0-9a-f]{24}$/)
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { path: "a.md" })
})
```

- [ ] **Step 2: Run the performance tests**

Run: `npm run test:perf`
Expected: both tests pass and print the medians. If a target is missed, profile the handler before changing any design decision; report the numbers to the user.

- [ ] **Step 3: Run the SDK compatibility test**

Run: `C2O_PYTHON=~/.hermes/hermes-agent/venv/bin/python npm test`
Expected: all tests pass, including "the official OpenAI Python SDK parses streamed text and tool calls".

- [ ] **Step 4: Commit**

```bash
git add test/performance/adapter-overhead.test.ts test/integration/openai-python-sdk.test.ts
git commit -m "test: add adapter performance and OpenAI SDK compatibility tests"
```

---

### Task 20: Documentation, examples, and CI

**Files:**
- Modify: `README.md` (replace), `.github/workflows/ci.yml` (replace)
- Create: `examples/hermes-config.yaml`, `examples/config.yaml`

**Interfaces:**
- Consumes: configuration names (Task 3), Hermes settings (spec section 14), Task 1 check 7 result.
- Produces: user-facing documentation and CI.

- [ ] **Step 1: Replace `README.md`**

````markdown
# cursor2openai

An OpenAI-compatible Chat Completions adapter that lets [Hermes Agent](https://github.com/NousResearch/hermes-agent) use a Cursor subscription as a custom provider. Each request runs the official Cursor CLI (`agent`) in read-only ask mode. Hermes runs every tool.

Design: [`docs/superpowers/specs/2026-09-25-hermes-cursor-adapter-design.md`](docs/superpowers/specs/2026-09-25-hermes-cursor-adapter-design.md)

## Requirements

- Node.js 22 or later
- The Cursor CLI, logged in: `curl https://cursor.com/install -fsS | bash`, then `agent login`

## Install and run

```bash
npm ci
npm run build
export CURSOR2OPENAI_API_KEY="$(openssl rand -hex 32)"
node dist/cli.js
```

On Linux, create the workspace folder once:

```bash
sudo install -d -o "$USER" -m 700 /var/lib/cursor2openai
```

The adapter listens on `http://127.0.0.1:8787/v1` by default.

## Configuration

Environment variables override `~/.cursor2openai/config.yaml` (keys are the lowercase names without the prefix, for example `port: 9000`). See [`examples/config.yaml`](examples/config.yaml).

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR2OPENAI_API_KEY` | required | Key Hermes must send. At least 32 characters. |
| `CURSOR2OPENAI_HOST` | `127.0.0.1` | Listening address. |
| `CURSOR2OPENAI_PORT` | `8787` | Listening port. |
| `CURSOR2OPENAI_TLS_CERT_FILE`, `CURSOR2OPENAI_TLS_KEY_FILE` | none | Enable HTTPS. Required for a non-loopback address unless insecure HTTP is allowed. |
| `CURSOR2OPENAI_ALLOW_INSECURE_HTTP` | `false` | Allow plain HTTP on a non-loopback address. |
| `CURSOR2OPENAI_DATA_DIR` | `~/.cursor2openai` | Conversation index, model cache, config file. |
| `CURSOR2OPENAI_WORKSPACE_DIR` | macOS `/Users/Shared/cursor2openai`, Linux `/var/lib/cursor2openai` | Folder `agent` runs in. Outside your home folder, mode `0700`. |
| `CURSOR2OPENAI_DEFAULT_MODEL` | `composer-2.5` | Model used when a request names none. |
| `CURSOR2OPENAI_AGENT_BIN` | `agent` | Path to the Cursor CLI. |
| `CURSOR2OPENAI_REQUEST_TIMEOUT_MS` | `600000` | Time limit for one `agent` run. |
| `CURSOR2OPENAI_MAX_CONCURRENT` | `4` | Maximum `agent` processes at once. |
| `CURSOR2OPENAI_MAX_QUEUED` | `16` | Maximum waiting requests. |
| `CURSOR2OPENAI_QUEUE_TIMEOUT_MS` | `60000` | Maximum wait for a free slot. |
| `CURSOR2OPENAI_CONVERSATION_TTL_DAYS` | `30` | How long an unused conversation can still be continued. |
| `CURSOR2OPENAI_MAX_CONVERSATIONS` | `10000` | Maximum stored conversations. |
| `CURSOR2OPENAI_MODEL_CACHE_MS` | `300000` | How long the model list is cached. |
| `CURSOR2OPENAI_MAX_BODY_BYTES` | `20971520` | Request size limit. |
| `CURSOR2OPENAI_DEBUG_LOG_AGENT_OUTPUT` | `false` | Log raw `agent` errors. They may contain prompt text. |

## Hermes configuration

Add the provider to your Hermes profile (`config.yaml`) and put `CURSOR2OPENAI_API_KEY` in the profile's `.env`. See [`examples/hermes-config.yaml`](examples/hermes-config.yaml).

- Choose the model and effort together by picking the exact Cursor model name, for example `gpt-5.6-sol-high`.
- The `model_overrides` block must appear under both `custom` and `custom:cursor`. Hermes runs named providers internally as `custom`.
- `session_affinity_header` lets the adapter continue Cursor sessions safely.
- Any Hermes task (main model, delegation, compression, titles) can use this provider.

## Security

- Every request needs the API key. Use HTTPS when Hermes runs on another machine.
- `agent` runs in ask mode with a fixed workspace and a Cursor permissions file that denies shell commands, writes, web fetches, MCP tools, and reads of your home folder and `/etc`.
- Remaining gap: Cursor can still read files outside the denied folders, and a symbolic link or another spelling of a path can get around the rules. For complete protection, run the adapter as a separate operating-system user with its own Cursor login, no MCP servers or rules in its Cursor settings, and no private files.
- Logs contain metadata only.

## Known limitations

- The model's reasoning text is not available: Cursor does not output it in print mode.
- Token usage is reported only when Cursor reports it for the whole conversation.
- `tool_choice`, `parallel_tool_calls`, and `response_format` are followed through instructions to the model.
- Cursor keeps its saved sessions on disk. The adapter never deletes Cursor's files or its own workspace folder. If you delete or move the workspace folder, existing conversations start a fresh Cursor session once.

## Development

```bash
npm test             # unit and integration tests, no real Cursor requests
npm run test:perf    # adapter performance targets
C2O_PYTHON=~/.hermes/hermes-agent/venv/bin/python npm test   # adds the OpenAI Python SDK test
node scripts/pre-implementation-checks.mjs                     # real Cursor checks (about 14 requests)
```

## License

MIT. Not an official Cursor or Nous Research product.
````

- [ ] **Step 2: Add the examples**

`examples/hermes-config.yaml`:

```yaml
# Add to your Hermes profile config.yaml. Put CURSOR2OPENAI_API_KEY in the profile's .env.
providers:
  cursor:
    api: https://adapter.local:8787/v1
    transport: chat_completions
    key_env: CURSOR2OPENAI_API_KEY
    default_model: composer-2.5
    session_affinity_header: X-Cursor2openai-Conversation
    # ssl_ca_cert: /path/to/self-signed-cert.pem

model_overrides:
  custom:
    _default:
      supports_reasoning: false
      supports_vision: true
  custom:cursor:
    _default:
      supports_reasoning: false
      supports_vision: true

model:
  provider: custom:cursor
  default: composer-2.5
```

`examples/config.yaml`:

```yaml
# Copy to ~/.cursor2openai/config.yaml. Environment variables override these values.
host: 127.0.0.1
port: 8787
default_model: composer-2.5
# tls_cert_file: /path/to/cert.pem
# tls_key_file: /path/to/key.pem
# workspace_dir: /var/lib/cursor2openai
conversation_ttl_days: 30
max_concurrent: 4
```

- [ ] **Step 3: Replace the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, master, "hermes-*"]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm audit --audit-level=low
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

- [ ] **Step 4: Verify everything together**

Run: `npm audit && npm run typecheck && npm run build && npm test`
Expected: `found 0 vulnerabilities`, no type errors, build succeeds, all tests pass.

Run: `npm ls --omit=dev --depth=0`
Expected: only `yaml` and `zod`.

- [ ] **Step 5: Commit**

```bash
git add README.md examples .github/workflows/ci.yml
git commit -m "docs: document cursor2openai setup, Hermes configuration, and security"
```

---

### Task 21: Linux check, Hermes probe, and manual end-to-end check

These steps need the user's machines. Run them together with the user.

**Files:**
- Create: `scripts/hermes-probe-server.mjs`, `docs/superpowers/results/2026-09-25-manual-checks.md` (date of the run)
- Create (by running the check script on Linux): `test/fixtures/agent/check-results-linux.json`

**Interfaces:**
- Consumes: the built adapter (Tasks 1 to 20).
- Produces: recorded results for spec section 15 checks 6 and 8 and spec section 13 manual and performance checks.

- [ ] **Step 1: Write the Hermes probe server**

`scripts/hermes-probe-server.mjs`:

```javascript
#!/usr/bin/env node
// Recording HTTPS server for spec section 15, check 8. Usage: node scripts/hermes-probe-server.mjs <cert.pem> <key.pem> [port]
import { appendFileSync, readFileSync } from "node:fs"
import https from "node:https"

const [certFile, keyFile, portText = "8788"] = process.argv.slice(2)
const log = (entry) => appendFileSync("requests.jsonl", `${JSON.stringify(entry)}\n`)
const base = { id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: "composer-2.5" }
const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end("data: [DONE]\n\n")
}

https
  .createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const json = body ? JSON.parse(body) : null
      log({ method: req.method, path: req.url, affinity: req.headers["x-cursor2openai-conversation"] ?? null, body: json })
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "composer-2.5", object: "model", created: 1, owned_by: "cursor" }] }))
        return
      }
      const hasToolResult = (json?.messages ?? []).some((message) => message.role === "tool")
      const canDescribe = (json?.tools ?? []).some((tool) => tool.function?.name === "tool_describe")
      if (canDescribe && !hasToolResult && !json?.response_format) {
        const call = { index: 0, id: "call_probe1", type: "function", function: { name: "tool_describe", arguments: JSON.stringify({ names: ["todo_list"] }) } }
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ])
        return
      }
      const text = json?.response_format ? '{"title":"Probe title"}' : "done"
      if (json?.stream) {
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ])
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "composer-2.5", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }))
    })
  })
  .listen(Number(portText), "127.0.0.1", () => console.log(`probe server on https://127.0.0.1:${portText}`))
```

- [ ] **Step 2: Run check 6 on the Linux machine**

On the Linux VM, with Node 22 and a logged-in Cursor CLI:

```bash
git clone git@github.com:sorcush/cursor2openai.git && cd cursor2openai && git checkout hermes-cursor-adapter
npm ci
node scripts/pre-implementation-checks.mjs
```

Expected: `PASS` for check 6. If it fails, stop and report to the user; the permissions design must be revisited for Linux.
Copy `test/fixtures/agent/check-results-linux.json` back into the repository.

- [ ] **Step 3: Repeat the Hermes probe on the machine where Hermes runs**

Run from the repository folder:

```bash
REPO="$(pwd)"
mkdir -p /tmp/c2o-probe && cd /tmp/c2o-probe
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1"
node "$REPO/scripts/hermes-probe-server.mjs" cert.pem key.pem 8788 &
mkdir -p home && cp "$REPO/examples/hermes-config.yaml" home/config.yaml
```

Edit `home/config.yaml`: set `api: https://127.0.0.1:8788/v1` and `ssl_ca_cert: /tmp/c2o-probe/cert.pem`. Create `home/.env` with `CURSOR2OPENAI_API_KEY=probe-key-0123456789abcdef0123456789abcdef`. Then:

```bash
HERMES_HOME=/tmp/c2o-probe/home hermes -z "Create a todo item called probe, then reply done." -t todo --ignore-rules
node -e 'for (const l of require("fs").readFileSync("requests.jsonl","utf8").trim().split("\n")) { const r = JSON.parse(l); console.log(r.method, r.path, "affinity=" + r.affinity, "effort=" + (r.body?.reasoning_effort ?? "absent"), "format=" + (r.body?.response_format?.type ?? "none")) }'
```

Expected: chat requests carry an affinity value; main requests have `effort=absent`; the title request has `format=json_schema`.
Check screenshot routing:

```bash
HERMES_HOME=/tmp/c2o-probe/home ~/.hermes/hermes-agent/venv/bin/python -c "import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent'); from hermes_cli.config import load_config; from agent.image_routing import decide_image_input_mode; print(decide_image_input_mode('custom', 'composer-2.5', load_config(), requested_provider='custom:cursor'))"
```

Expected: `native`. Stop the probe server and delete `/tmp/c2o-probe`.

- [ ] **Step 4: Run the manual end-to-end check**

Start the built adapter with the real configuration (HTTPS on the network address, or loopback). Point a Hermes profile at it using `examples/hermes-config.yaml`. With real Hermes and Cursor, do each of these and note the result:

1. A simple chat, with `streaming.enabled` both true and false in the profile.
2. A multi-step tool task.
3. A screenshot.
4. Switching models mid-conversation.
5. Restarting the adapter mid-conversation.
6. A conversation long enough for Hermes to compress its history.
7. Title generation and compression assigned to the Cursor provider.
8. A subagent (delegation) assigned to the Cursor provider.
9. The effort picker in Hermes Desktop for this provider is hidden or disabled.

- [ ] **Step 5: Compute the log measurements**

Save the adapter's log to `adapter.log` during step 4, then run:

```bash
node -e '
const rows = require("fs").readFileSync("adapter.log", "utf8").split("\n").filter((l) => l.includes("\"event\":\"request\"")).map(JSON.parse)
const later = rows.filter((r) => r.freshReason !== "new")
const continued = later.filter((r) => r.mode === "continued")
const ratios = continued.filter((r) => r.fullPromptChars).map((r) => r.promptChars / r.fullPromptChars)
console.log({ requests: rows.length, continuedShare: continued.length / Math.max(later.length, 1), noMatch: later.filter((r) => r.freshReason === "no-match").length, medianPromptRatio: ratios.sort()[Math.floor(ratios.length / 2)] })'
```

Expected: `continuedShare` above 0.9, excluding steps right after compression. Investigate every `no-match` on a normal step: it means the canonical form in `src/conversation/fingerprint.ts` does not match what Hermes sends back.

- [ ] **Step 6: Record and commit the results**

Write `docs/superpowers/results/2026-09-25-manual-checks.md` (use the actual date) with: the Linux check 6 outcome, the Hermes probe outcome, the result of each of the nine manual checks, the `npm run test:perf` medians, and the log measurements.

```bash
git add scripts/hermes-probe-server.mjs test/fixtures/agent/check-results-linux.json docs/superpowers/results
git commit -m "docs: record Linux, Hermes probe, and end-to-end check results"
```

