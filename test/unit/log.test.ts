import assert from "node:assert/strict"
import { test } from "node:test"
import { createLogger } from "../../src/log.js"

const capture = (debugAgentOutput: boolean) => {
  const lines: string[] = []
  const logger = createLogger({ debugAgentOutput, write: (line) => lines.push(line), now: () => new Date("2026-09-25T00:00:00Z") })
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) }
}

test("request entries are single JSON lines with metadata only", () => {
  const { logger, parsed } = capture(false)
  logger.request({ requestId: "r1", model: "composer-2.5", mode: "continued", status: 200, durationMs: 12 })
  assert.deepEqual(parsed()[0], { time: "2026-09-25T00:00:00.000Z", level: "info", event: "request", requestId: "r1", model: "composer-2.5", mode: "continued", status: 200, durationMs: 12 })
})

test("agent output is logged only in debug mode, cut to 2000 characters", () => {
  const off = capture(false)
  off.logger.agentOutput("r1", "secret prompt text")
  assert.equal(off.lines.length, 0)
  const on = capture(true)
  on.logger.agentOutput("r1", "x".repeat(3000))
  assert.equal((on.parsed()[0].output as string).length, 2000)
})
