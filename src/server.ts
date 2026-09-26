import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import { QueueAbortedError, type RequestQueue } from "./concurrency.js"
import type { ModelCatalog } from "./cursor/model-list.js"
import { type ChatDeps, handleChatCompletions } from "./openai/chat-completions.js"
import { AdapterError } from "./openai/errors.js"
import { sendError, sendJson } from "./openai/response-writer.js"

export type ServerOptions = {
  apiKey: string
  maxBodyBytes: number
  queue: Pick<RequestQueue, "acquire" | "close">
  models: Pick<ModelCatalog, "has" | "list">
  chat: Omit<ChatDeps, "models" | "trackRequest">
  tls?: { cert: Buffer; key: Buffer }
  timeouts?: { headersMs?: number; requestMs?: number; keepAliveMs?: number; checkIntervalMs?: number }
}

export type AdapterServer = {
  server: http.Server
  listen(port: number, host: string): Promise<number>
  shutdown(graceMs: number): Promise<void>
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest()

// SECURITY-REVIEW: API key check; both values are hashed to equal length and compared in constant time.
export const isAuthorized = (header: string | undefined, apiKey: string): boolean => {
  const match = /^Bearer (.+)$/.exec(header ?? "")
  return match !== null && timingSafeEqual(digest(match[1]), digest(apiKey))
}

const tooLarge = (): AdapterError => new AdapterError(413, "request_too_large", "The request body is too large")
const methodNotAllowed = (): AdapterError => new AdapterError(405, "method_not_allowed", "Method not allowed")

// SECURITY-REVIEW: parses external JSON with a size limit.
export const readJsonBody = (req: IncomingMessage, limit: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"])
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on("end", () => {
      if (size > limit) {
        reject(tooLarge())
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new AdapterError(400, "invalid_request_error", "The request body is not valid JSON"))
      }
    })
    req.on("error", reject)
  })

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const jsonContentType = (value: string): boolean => /^application\/json(\s*;|\s*$)/i.test(value.trim())

type RouteContext = {
  path: string
  logMeta: (status: number, errorClass?: string) => void
  reachedHandler: { value: boolean }
}

export const createAdapterServer = (options: ServerOptions): AdapterServer => {
  const active = new Set<AbortController>()
  const chat: ChatDeps = {
    ...options.chat,
    models: options.models,
    trackRequest: (controller) => {
      active.add(controller)
      return () => active.delete(controller)
    },
  }

  const route = async (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> => {
    if (req.method === "OPTIONS") throw methodNotAllowed()
    if (!isAuthorized(req.headers.authorization, options.apiKey)) throw new AdapterError(401, "invalid_api_key", "Invalid API key")
    if (ctx.path === "/v1/models") {
      if (req.method !== "GET") throw methodNotAllowed()
      const created = Math.floor(Date.now() / 1000)
      const ids = await options.models.list()
      sendJson(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created, owned_by: "cursor" })) })
      ctx.logMeta(200)
      return
    }
    if (ctx.path !== "/v1/chat/completions") throw new AdapterError(404, "not_found", "Not found")
    if (req.method !== "POST") throw methodNotAllowed()
    if (!jsonContentType(req.headers["content-type"] ?? "")) {
      throw new AdapterError(400, "invalid_request_error", "Content-Type must be application/json")
    }
    const disconnect = new AbortController()
    const onClientClose = (): void => {
      if (!res.writableFinished) disconnect.abort()
    }
    res.on("close", onClientClose)
    let release: (() => void) | undefined
    try {
      const body = await readJsonBody(req, options.maxBodyBytes)
      release = await options.queue.acquire(disconnect.signal)
      if (disconnect.signal.aborted) {
        release()
        ctx.logMeta(499, "client_disconnected")
        return
      }
      ctx.reachedHandler.value = true
      await handleChatCompletions(req, res, body, chat)
    } catch (error) {
      if (error instanceof QueueAbortedError) {
        ctx.logMeta(499, "client_disconnected")
        return
      }
      throw error
    } finally {
      res.off("close", onClientClose)
      release?.()
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const started = Date.now()
    const requestId = randomBytes(8).toString("hex")
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    const reachedHandler = { value: false }
    const logMeta = (status: number, errorClass?: string): void => {
      options.chat.logger.request({ requestId, model: "", route: path, status, errorClass, durationMs: Date.now() - started })
    }
    route(req, res, { path, logMeta, reachedHandler }).catch((error: unknown) => {
      if (error instanceof QueueAbortedError) {
        logMeta(499, "client_disconnected")
        return
      }
      const failure = error instanceof AdapterError ? error : new AdapterError(500, "internal_error", "Internal adapter error")
      if (!reachedHandler.value) logMeta(failure.status, failure.code)
      if (failure.status === 413) res.setHeader("connection", "close")
      if (!res.headersSent) sendError(res, failure)
      else res.end()
      req.resume()
    })
  }

  const serverOptions = { connectionsCheckingInterval: options.timeouts?.checkIntervalMs ?? 1000 }
  const server: http.Server = options.tls
    ? https.createServer({ ...serverOptions, cert: options.tls.cert, key: options.tls.key }, handler)
    : http.createServer(serverOptions, handler)
  server.headersTimeout = options.timeouts?.headersMs ?? 10_000
  server.requestTimeout = options.timeouts?.requestMs ?? 60_000
  server.keepAliveTimeout = options.timeouts?.keepAliveMs ?? 5_000

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          server.off("error", reject)
          resolve((server.address() as AddressInfo).port)
        })
      }),
    shutdown: async (graceMs) => {
      options.queue.close()
      server.close()
      server.closeIdleConnections()
      const deadline = Date.now() + graceMs
      while (active.size > 0 && Date.now() < deadline) await delay(50)
      for (const controller of active) controller.abort()
      const hardDeadline = Date.now() + 5000
      while (active.size > 0 && Date.now() < hardDeadline) await delay(50)
      server.closeAllConnections()
    },
  }
}
