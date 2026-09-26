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
