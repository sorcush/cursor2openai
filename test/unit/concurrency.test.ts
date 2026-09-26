import assert from "node:assert/strict"
import { test } from "node:test"
import { QueueAbortedError, RequestQueue } from "../../src/concurrency.js"
import { AdapterError } from "../../src/openai/errors.js"

const busy = (error: unknown) => error instanceof AdapterError && error.status === 503 && error.code === "server_busy"
const aborted = (error: unknown) => error instanceof QueueAbortedError

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

test("aborting a waiting request rejects it and the slot goes to the next waiter", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1000 })
  const release = await queue.acquire()
  const controller = new AbortController()
  let acquired = false
  const waiting = queue.acquire(controller.signal).then((next) => {
    acquired = true
    return next
  })
  const abortedWait = assert.rejects(waiting, aborted)
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  await abortedWait
  assert.equal(acquired, false)
  const controller2 = new AbortController()
  const next = queue.acquire(controller2.signal)
  release()
  const releaseNext = await next
  releaseNext()
})

test("an already-aborted signal rejects at once", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1000 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(queue.acquire(controller.signal), aborted)
})

test("close rejects current waiters and later acquires with server_busy", async () => {
  const queue = new RequestQueue({ maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 1000 })
  const release = await queue.acquire()
  const waiting = assert.rejects(queue.acquire(), busy)
  queue.close()
  await waiting
  await assert.rejects(queue.acquire(), busy)
  release()
})
