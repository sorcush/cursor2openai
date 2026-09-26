import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { type Harness, startAdapter } from "../helpers/adapter-harness.js"
import { deltaEvent, initEvent, replyLines, resultEvent } from "../helpers/agent-events.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
let dir: { path: string; cleanup(): Promise<void> }
let harness: Harness | undefined
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(async () => {
  await harness?.stop()
  harness = undefined
  await dir.cleanup()
})

test("the adapter adds under 10 ms per request, excluding agent start", async () => {
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines: replyLines("s1", "Hello") }] })
  let messages: unknown[] = [{ role: "user", content: "hi" }]
  for (let i = 0; i < 30; i += 1) {
    const body = (await (await harness.post({ messages })).json()) as any
    messages = [...messages, { role: "assistant", content: body.choices[0].message.content }, { role: "user", content: `next ${i}` }]
  }
  const adapterMs = harness.logs.map((entry) => entry.adapterMs ?? Number.POSITIVE_INFINITY)
  const continued = harness.logs.filter((entry) => entry.mode === "continued").length
  console.log(`adapterMs median ${median(adapterMs)} ms, continued ${continued}/${harness.logs.length - 1}`)
  assert.ok(median(adapterMs) < 10)
})

test("streamed text reaches the client within 5 ms of leaving agent", async () => {
  const lines = [initEvent("s1"), ...Array.from({ length: 20 }, () => deltaEvent("s1", "T{{now}};")), resultEvent("s1", "")]
  harness = await startAdapter({ dir: dir.path, scenarios: [{ lines, lineDelayMs: 20 }] })
  const response = await harness.post({ messages: [{ role: "user", content: "hi" }], stream: true })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const delays: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const received = Date.now()
    for (const match of decoder.decode(value, { stream: true }).matchAll(/T(\d+);/g)) delays.push(received - Number(match[1]))
  }
  console.log(`relay delay median ${median(delays)} ms over ${delays.length} chunks`)
  assert.ok(delays.length >= 20)
  assert.ok(median(delays) < 5)
})
