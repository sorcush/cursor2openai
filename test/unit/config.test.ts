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
