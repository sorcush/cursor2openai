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
