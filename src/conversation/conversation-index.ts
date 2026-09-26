import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname } from "node:path"

export type IndexEntry = { sessionId: string; marker: string; lastUsedAt: number }

export type IndexOptions = {
  filePath: string
  ttlMs: number
  maxEntries: number
  batchDelayMs?: number
  now?: () => number
  onWarning?: (message: string) => void
}

type IndexFile = { version: 1; entries: Record<string, IndexEntry> }

const isEntry = (value: unknown): value is IndexEntry => {
  const entry = value as IndexEntry
  return typeof entry?.sessionId === "string" && typeof entry.marker === "string" && typeof entry.lastUsedAt === "number"
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r").catch(() => undefined)
  if (!handle) return
  try {
    await handle.sync()
  } catch (error) {
    // Some platforms and file systems cannot fsync a directory.
    const code = (error as NodeJS.ErrnoException).code ?? ""
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(code)) throw error
  } finally {
    await handle.close()
  }
}

export class ConversationIndex {
  private readonly entries = new Map<string, IndexEntry>()
  private writeChain: Promise<void> = Promise.resolve()
  private batchTimer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined
  private readonly now: () => number

  private constructor(private readonly options: IndexOptions) {
    this.now = options.now ?? Date.now
  }

  static async open(options: IndexOptions): Promise<ConversationIndex> {
    const index = new ConversationIndex(options)
    await index.load()
    index.prune()
    index.pruneTimer = setInterval(() => index.prune(), 3_600_000)
    index.pruneTimer.unref()
    return index
  }

  async take(key: string): Promise<IndexEntry | undefined> {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    await this.save()
    return entry
  }

  add(key: string, value: { sessionId: string; marker: string }): void {
    this.entries.delete(key)
    this.entries.set(key, { ...value, lastUsedAt: this.now() })
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.scheduleBatch()
  }

  prune(): void {
    const cutoff = this.now() - this.options.ttlMs
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.scheduleBatch()
  }

  size(): number {
    return this.entries.size
  }

  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    await this.save()
  }

  async close(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    await this.flush()
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.options.filePath, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        this.options.onWarning?.("No conversation index found; starting with an empty index")
      } else {
        this.options.onWarning?.(`Could not read the conversation index: ${(error as Error).message}`)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw) as IndexFile
      const loaded = Object.entries(parsed.entries ?? {}).filter((pair): pair is [string, IndexEntry] => isEntry(pair[1]))
      loaded.sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
      for (const [key, entry] of loaded) this.entries.set(key, entry)
    } catch {
      this.options.onWarning?.("The conversation index is unreadable; starting with an empty index")
    }
  }

  private scheduleBatch(): void {
    if (this.batchTimer) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.save().catch((error: unknown) => this.options.onWarning?.(`Could not save the conversation index: ${(error as Error).message}`))
    }, this.options.batchDelayMs ?? 1000)
    this.batchTimer.unref()
  }

  // Saves run one at a time, and each writes the state at the moment it runs, so an older save never overwrites a newer one.
  private save(): Promise<void> {
    const run = this.writeChain.then(() => this.writeSnapshot())
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async writeSnapshot(): Promise<void> {
    const target = this.options.filePath
    const temp = `${target}.${process.pid}.tmp`
    const data: IndexFile = { version: 1, entries: Object.fromEntries(this.entries) }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const handle = await open(temp, "w", 0o600)
    try {
      await handle.writeFile(JSON.stringify(data))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, target)
    await syncDirectory(dirname(target))
  }
}
