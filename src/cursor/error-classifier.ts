import { AdapterError } from "../openai/errors.js"

type Rule = { pattern: RegExp; build: (detail: string) => AdapterError }

// Cursor does not document its error codes. Patterns come from recorded samples in test/fixtures/agent/errors.
const RULES: Rule[] = [
  {
    pattern: /not logged in|login required|please log in|unauthori[sz]ed|authentication (failed|required)|invalid api key|api key is invalid|provided API key is invalid/i,
    build: (detail) => new AdapterError(503, "service_unavailable", "The Cursor CLI is not logged in", detail),
  },
  {
    pattern: /usage limit|spend(ing)? limit|quota|out of (fast )?requests|limit reached/i,
    build: (detail) => new AdapterError(429, "insufficient_quota", "Cursor usage limit reached", detail),
  },
  {
    pattern: /\b429\b|rate.?limit|too many requests/i,
    build: (detail) => new AdapterError(429, "rate_limit_exceeded", "Cursor rate limit reached", detail),
  },
  {
    pattern: /context (length|window)|too long|maximum context|prompt is too large|token limit/i,
    build: (detail) => new AdapterError(400, "context_length_exceeded", "The conversation is too long for this model", detail),
  },
  {
    pattern: /(unknown|invalid|unsupported) model|model .{0,80}not (found|available|supported)|cannot use this model/i,
    build: (detail) => new AdapterError(404, "model_not_found", "Cursor does not recognize this model", detail),
  },
]

export const classifyAgentFailure = ({ stderr, exitCode }: { stderr: string; exitCode: number | null }): AdapterError => {
  for (const rule of RULES) if (rule.pattern.test(stderr)) return rule.build(stderr)
  return new AdapterError(
    502,
    "upstream_error",
    exitCode === null ? "The Cursor CLI stopped unexpectedly" : `The Cursor CLI failed with exit code ${exitCode}`,
    stderr,
  )
}
