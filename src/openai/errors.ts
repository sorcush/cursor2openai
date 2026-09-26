export type ErrorCode =
  | "invalid_request_error"
  | "invalid_api_key"
  | "model_not_found"
  | "not_found"
  | "method_not_allowed"
  | "request_too_large"
  | "rate_limit_exceeded"
  | "insufficient_quota"
  | "context_length_exceeded"
  | "server_busy"
  | "service_unavailable"
  | "timeout"
  | "upstream_error"
  | "internal_error"

export class AdapterError extends Error {
  readonly status: number
  readonly code: ErrorCode
  // Never sent to clients: may contain prompt text from agent output.
  readonly detail?: string

  constructor(status: number, code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = "AdapterError"
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export const errorBody = (error: AdapterError) => ({
  error: { message: error.message, type: error.code, code: error.code },
})
