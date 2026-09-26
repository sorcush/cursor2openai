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
