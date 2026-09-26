import type { AgentUsage } from "./agent-runner.js"

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

// Set from pre-implementation check 3: true only if a resumed session reports usage for the whole conversation.
export const CURSOR_USAGE_COVERS_CONVERSATION = false

export const toOpenAiUsage = (usage: AgentUsage | undefined, coversConversation = CURSOR_USAGE_COVERS_CONVERSATION): Usage | undefined => {
  if (!coversConversation || !usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return undefined
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return { prompt_tokens: prompt, completion_tokens: usage.outputTokens, total_tokens: prompt + usage.outputTokens }
}
