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
