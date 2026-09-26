import { AdapterError } from "./openai/errors.js"

export type QueueOptions = { maxConcurrent: number; maxQueued: number; queueTimeoutMs: number }

const busy = (): AdapterError => new AdapterError(503, "server_busy", "The adapter is busy; try again shortly")

export class RequestQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly options: QueueOptions) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1
      return this.releaser()
    }
    if (this.waiting.length >= this.options.maxQueued) throw busy()
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const position = this.waiting.indexOf(grant)
        if (position !== -1) this.waiting.splice(position, 1)
        reject(busy())
      }, this.options.queueTimeoutMs)
      this.waiting.push(grant)
    })
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}
