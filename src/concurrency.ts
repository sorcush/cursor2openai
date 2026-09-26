import { AdapterError } from "./openai/errors.js"

export type QueueOptions = { maxConcurrent: number; maxQueued: number; queueTimeoutMs: number }

const busy = (): AdapterError => new AdapterError(503, "server_busy", "The adapter is busy; try again shortly")

export class QueueAbortedError extends Error {
  constructor() {
    super("The client disconnected while waiting")
    this.name = "QueueAbortedError"
  }
}

type Waiter = {
  grant: () => void
  cancel: (error: Error) => void
}

export class RequestQueue {
  private active = 0
  private readonly waiting: Waiter[] = []
  private closed = false

  constructor(private readonly options: QueueOptions) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) throw busy()
    if (signal?.aborted) throw new QueueAbortedError()

    if (this.active < this.options.maxConcurrent) {
      this.active += 1
      return this.releaser()
    }
    if (this.waiting.length >= this.options.maxQueued) throw busy()

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort && signal) signal.removeEventListener("abort", onAbort)
      }

      const entry: Waiter = {
        grant: () => {
          cleanup()
          resolve()
        },
        cancel: (error) => {
          cleanup()
          const position = this.waiting.indexOf(entry)
          if (position !== -1) this.waiting.splice(position, 1)
          reject(error)
        },
      }

      timer = setTimeout(() => entry.cancel(busy()), this.options.queueTimeoutMs)

      if (signal) {
        onAbort = () => entry.cancel(new QueueAbortedError())
        signal.addEventListener("abort", onAbort, { once: true })
      }

      this.waiting.push(entry)
    })

    return this.releaser()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = busy()
    while (this.waiting.length > 0) this.waiting.shift()?.cancel(error)
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next.grant()
      else this.active -= 1
    }
  }
}
