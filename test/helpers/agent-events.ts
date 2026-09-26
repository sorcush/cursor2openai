const assistant = (sessionId: string, text: string, extra: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId, ...extra })

export const initEvent = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "Composer 2.5", cwd: "/fake" })
export const deltaEvent = (sessionId: string, text: string): string => assistant(sessionId, text, { timestamp_ms: 1 })
export const toolFlushEvent = (sessionId: string, text: string): string => assistant(sessionId, text, { timestamp_ms: 2, model_call_id: "mc_1" })
export const finalFlushEvent = (sessionId: string, text: string): string => assistant(sessionId, text, {})
export const resultEvent = (sessionId: string, text: string, usage?: Record<string, number>): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, ...(usage ? { usage } : {}) })

export const replyLines = (sessionId: string, text: string): string[] => [
  initEvent(sessionId),
  deltaEvent(sessionId, text),
  finalFlushEvent(sessionId, text),
  resultEvent(sessionId, text),
]

export const toolReplyLines = (sessionId: string, calls: Array<{ name: string; arguments?: unknown }>, before = ""): string[] =>
  replyLines(sessionId, `${before}<{{marker}}>\n${JSON.stringify(calls)}\n</{{marker}}>`)
