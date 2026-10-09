import { readFile } from "node:fs/promises"
import { StartupError } from "../startup-error.js"

// Hides models from the /v1/models list. Each non-empty, non-comment line of the file is a pattern
// that must match a whole model name, ignoring case. Chat requests ignore the filter.
export type ModelFilterOptions = {
  file: string
  onWarning?: (message: string) => void
}

const parsePatterns = (text: string, file: string): RegExp[] => {
  const patterns: RegExp[] = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    try {
      patterns.push(new RegExp(`^(?:${line})$`, "i"))
    } catch (error) {
      throw new Error(`${file} line ${index + 1} is not a valid pattern: ${(error as Error).message}`)
    }
  }
  return patterns
}

export class ModelFilter {
  private patterns: RegExp[] = []
  private lastText: string | undefined
  private warnedText: string | undefined

  constructor(private readonly options: ModelFilterOptions) {}

  async init(): Promise<void> {
    try {
      await this.reload()
    } catch (error) {
      throw new StartupError((error as Error).message)
    }
  }

  async apply(ids: string[]): Promise<string[]> {
    try {
      await this.reload()
    } catch (error) {
      const message = `${(error as Error).message}. Keeping the previous model filter`
      if (this.warnedText !== message) this.options.onWarning?.(message)
      this.warnedText = message
    }
    return ids.filter((id) => !this.patterns.some((pattern) => pattern.test(id)))
  }

  private async reload(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.options.file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read ${this.options.file}: ${(error as Error).message}`)
      text = ""
    }
    if (text === this.lastText) return
    this.patterns = parsePatterns(text, this.options.file)
    this.lastText = text
    this.warnedText = undefined
  }
}
