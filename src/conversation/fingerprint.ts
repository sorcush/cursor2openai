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
