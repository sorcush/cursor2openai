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
