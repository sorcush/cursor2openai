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
    // SECURITY-REVIEW: runs the Cursor CLI with a fixed argument list, an allowlisted environment, no shell, and the prompt on stdin; model names starting with "-" are rejected above.
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
        // SECURITY-REVIEW: signals only the process group this adapter created for this run.
        process.kill(-pid, "SIGTERM")
      } catch {
        return
      }
      setTimeout(() => {
        try {
          // SECURITY-REVIEW: signals only the process group this adapter created for this run.
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
    // SECURITY-REVIEW: runs the Cursor CLI with caller-fixed arguments, the allowlisted environment, and no shell.
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
