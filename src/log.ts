export type RequestLogEntry = {
  requestId: string
  model: string
  route?: string
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
