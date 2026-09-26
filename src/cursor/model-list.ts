import { readFile, rename, writeFile } from "node:fs/promises"
import { AdapterError } from "../openai/errors.js"
import { StartupError } from "../startup-error.js"

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export const parseModelList = (stdout: string): string[] => {
  const ids = new Set<string>()
  for (const line of stdout.replace(ANSI, "").split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/[\]=,-]*) - /.exec(line.trim())
    if (match) ids.add(match[1])
  }
  return [...ids]
}

export type ModelCatalogOptions = {
  cacheFile: string
  cacheMs: number
  fetchList: () => Promise<string[]>
  now?: () => number
  onWarning?: (message: string) => void
}

export class ModelCatalog {
  private ids: string[] = []
  private fetchedAt = 0
  private refreshing: Promise<void> | undefined

  constructor(private readonly options: ModelCatalogOptions) {}

  async init(): Promise<void> {
    try {
      await this.refresh()
    } catch (error) {
      if (!(await this.loadCache())) throw new StartupError(`Could not get the Cursor model list: ${(error as Error).message}`)
      this.options.onWarning?.("Using the saved model list because the Cursor CLI could not list models")
    }
  }

  async list(): Promise<string[]> {
    if (this.now() - this.fetchedAt >= this.options.cacheMs) {
      try {
        await this.refreshOnce()
      } catch {
        this.fetchedAt = this.now()
        if (this.ids.length === 0) throw new AdapterError(503, "service_unavailable", "The Cursor model list is unavailable")
      }
    }
    return this.ids
  }

  async has(model: string): Promise<boolean> {
    return (await this.list()).includes(model)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private refreshOnce(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(): Promise<void> {
    const ids = await this.options.fetchList()
    if (ids.length === 0) throw new Error("the Cursor CLI returned no models")
    this.ids = ids
    this.fetchedAt = this.now()
    const temp = `${this.options.cacheFile}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ ids }), { mode: 0o600 })
    await rename(temp, this.options.cacheFile)
  }

  private async loadCache(): Promise<boolean> {
    try {
      const data = JSON.parse(await readFile(this.options.cacheFile, "utf8")) as { ids?: unknown }
      if (Array.isArray(data.ids) && data.ids.length > 0 && data.ids.every((id) => typeof id === "string")) {
        this.ids = data.ids
        this.fetchedAt = this.now()
        return true
      }
    } catch {
      // No usable saved list.
    }
    return false
  }
}
