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
