import assert from "node:assert/strict"
import { test } from "node:test"
import { RequestQueue } from "../../src/concurrency.js"
import { AdapterError } from "../../src/openai/errors.js"

const busy = (error: unknown) => error instanceof AdapterError && error.status === 503 && error.code === "server_busy"

test("waiting requests get a slot when one is released", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1000 })
  const release = await queue.acquire()
  let acquired = false
  const waiting = queue.acquire().then((next) => {
    acquired = true
    return next
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(acquired, false)
  release()
  release()
  const next = await waiting
  assert.equal(acquired, true)
  next()
})

test("a full queue rejects at once", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 1000 })
  const release = await queue.acquire()
  await assert.rejects(queue.acquire(), busy)
  release()
})

test("a request that waits too long is rejected", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 50 })
  const release = await queue.acquire()
  await assert.rejects(queue.acquire(), busy)
  release()
  const again = await queue.acquire()
  again()
})
