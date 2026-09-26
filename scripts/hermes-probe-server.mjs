#!/usr/bin/env node
// Recording HTTPS server for spec section 15, check 8. Usage: node scripts/hermes-probe-server.mjs <cert.pem> <key.pem> [port]
import { appendFileSync, readFileSync } from "node:fs"
import https from "node:https"

const [certFile, keyFile, portText = "8788"] = process.argv.slice(2)
const log = (entry) => appendFileSync("requests.jsonl", `${JSON.stringify(entry)}\n`)
const base = { id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: "composer-2.5" }
const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end("data: [DONE]\n\n")
}

https
  .createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const json = body ? JSON.parse(body) : null
      log({ method: req.method, path: req.url, affinity: req.headers["x-cursor2openai-conversation"] ?? null, body: json })
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "composer-2.5", object: "model", created: 1, owned_by: "cursor" }] }))
        return
      }
      const hasToolResult = (json?.messages ?? []).some((message) => message.role === "tool")
      const canDescribe = (json?.tools ?? []).some((tool) => tool.function?.name === "tool_describe")
      if (canDescribe && !hasToolResult && !json?.response_format) {
        const call = { index: 0, id: "call_probe1", type: "function", function: { name: "tool_describe", arguments: JSON.stringify({ names: ["todo_list"] }) } }
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ])
        return
      }
      const text = json?.response_format ? '{"title":"Probe title"}' : "done"
      if (json?.stream) {
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ])
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "composer-2.5", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }))
    })
  })
  .listen(Number(portText), "127.0.0.1", () => console.log(`probe server on https://127.0.0.1:${portText}`))
