import { randomBytes } from "node:crypto"
import type { ChatTool, ToolChoice } from "../openai/types.js"

export const MAX_BLOCK_BYTES = 1_048_576

export type ParsedToolCall = { name: string; arguments: string }

export type BlockParseResult =
  | { ok: true; calls: ParsedToolCall[] }
  | { ok: false; retryable: boolean; reason: string }

export const createMarker = (): string => `TOOL_CALLS_${randomBytes(4).toString("hex")}`
export const openingLine = (marker: string): string => `<${marker}>`
export const closingLine = (marker: string): string => `</${marker}>`

const choiceRule = (toolChoice: ToolChoice): string => {
  if (toolChoice === "required") return "You must request at least one tool in this reply."
  if (typeof toolChoice === "object") return `You must request the tool named ${toolChoice.function.name} in this reply.`
  return "Request a tool only when you need one. Otherwise answer normally, without a block."
}

export const toolInstructions = (input: {
  marker: string
  tools: ChatTool[]
  toolChoice: ToolChoice
  parallelToolCalls: boolean
}): string =>
  [
    "You are the model behind an OpenAI-compatible chat API. The client application runs every tool on the user's machine.",
    "Do not use tools of your own, except reading image files you are explicitly asked to view.",
    "To request tools, write one block in exactly this format, with each marker alone on its own line:",
    openingLine(input.marker),
    '[{"name": "<tool name>", "arguments": {<arguments as a JSON object>}}]',
    closingLine(input.marker),
    "Rules:",
    "- Normal text may come before the block.",
    "- Write at most one block per reply.",
    input.parallelToolCalls ? "- The block may request several tools." : "- The block must request exactly one tool.",
    "- Stop writing immediately after the closing marker.",
    "- Use only tool names from the list below.",
    `- ${choiceRule(input.toolChoice)}`,
    "",
    "Available tools:",
    ...input.tools.map(
      (tool) => `- ${tool.function.name}: ${tool.function.description ?? ""}\n  parameters: ${JSON.stringify(tool.function.parameters ?? {})}`,
    ),
  ].join("\n")

export const toolReminder = (input: { marker: string; toolChoice: ToolChoice; parallelToolCalls: boolean }): string =>
  `(Reminder: request tools only with one ${openingLine(input.marker)} ... ${closingLine(input.marker)} block, each marker alone on its own line${
    input.parallelToolCalls ? "" : ", exactly one tool"
  }. ${choiceRule(input.toolChoice)})`

export const parseToolBlock = (body: string): BlockParseResult => {
  if (Buffer.byteLength(body) > MAX_BLOCK_BYTES) return { ok: false, retryable: false, reason: "block too large" }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, retryable: true, reason: "not valid JSON" }
  }
  if (!Array.isArray(parsed)) return { ok: false, retryable: false, reason: "not a JSON array" }
  if (parsed.length === 0) return { ok: false, retryable: false, reason: "no tool calls" }
  const calls: ParsedToolCall[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, retryable: false, reason: "item is not an object" }
    const { name, arguments: args } = item as { name?: unknown; arguments?: unknown }
    if (typeof name !== "string" || !name.trim()) return { ok: false, retryable: false, reason: "item has no name" }
    if (args === undefined) calls.push({ name, arguments: "{}" })
    else if (typeof args === "string") calls.push({ name, arguments: args })
    else if (typeof args === "object" && args !== null && !Array.isArray(args)) calls.push({ name, arguments: JSON.stringify(args) })
    else return { ok: false, retryable: false, reason: "arguments must be an object or a string" }
  }
  return { ok: true, calls }
}
