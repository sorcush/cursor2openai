import { closingLine, MAX_BLOCK_BYTES, openingLine, parseToolBlock, type ParsedToolCall } from "./tool-protocol.js"

export type SplitterEvent = { type: "text"; text: string } | { type: "tool_calls"; calls: ParsedToolCall[] }
export type SplitterSummary = { droppedChars: number; invalidBlockReason?: string }

type State = "text" | "block" | "after" | "passthrough"

const withoutCarriageReturn = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line)

export class StreamSplitter {
  private state: State
  private pending = ""
  private block = ""
  private scanned = 0
  private dropped = 0
  private invalidReason: string | undefined
  private readonly opening: string
  private readonly closing: string

  constructor(marker: string | undefined) {
    this.state = marker ? "text" : "passthrough"
    this.opening = marker ? openingLine(marker) : ""
    this.closing = marker ? closingLine(marker) : ""
  }

  push(chunk: string): SplitterEvent[] {
    const events: SplitterEvent[] = []
    if (!chunk) return events
    if (this.state === "passthrough") events.push({ type: "text", text: chunk })
    else if (this.state === "after") this.dropped += chunk.length
    else if (this.state === "text") this.pushText(chunk, events)
    else this.pushBlock(chunk, events)
    return events
  }

  end(): { events: SplitterEvent[]; summary: SplitterSummary } {
    const events: SplitterEvent[] = []
    if (this.state === "text" && this.pending) {
      events.push({ type: "text", text: this.pending })
      this.pending = ""
    } else if (this.state === "block") {
      const tail = withoutCarriageReturn(this.block.slice(this.scanned))
      const result = tail === this.closing ? parseToolBlock(this.block.slice(0, this.scanned)) : undefined
      if (result?.ok) {
        events.push({ type: "tool_calls", calls: result.calls })
        this.state = "after"
      } else if (result && !result.ok) {
        this.failBlock(result.reason, events)
      } else if (Buffer.byteLength(this.block) > MAX_BLOCK_BYTES) {
        this.failBlock("block too large", events)
      } else {
        this.failBlock("missing closing marker", events)
      }
    }
    return { events, summary: { droppedChars: this.dropped, invalidBlockReason: this.invalidReason } }
  }

  private pushText(chunk: string, events: SplitterEvent[]): void {
    let buffer = this.pending + chunk
    this.pending = ""
    let output = ""
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      if (withoutCarriageReturn(buffer.slice(0, newline)) === this.opening) {
        if (output) events.push({ type: "text", text: output })
        this.state = "block"
        this.block = ""
        this.scanned = 0
        const rest = buffer.slice(newline + 1)
        if (rest) this.pushBlock(rest, events)
        return
      }
      output += buffer.slice(0, newline + 1)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
    if (buffer && this.opening.startsWith(buffer)) this.pending = buffer
    else output += buffer
    if (output) events.push({ type: "text", text: output })
  }

  private pushBlock(chunk: string, events: SplitterEvent[]): void {
    this.block += chunk
    if (Buffer.byteLength(this.block) > MAX_BLOCK_BYTES + this.closing.length + 2) {
      this.failBlock("block too large", events)
      return
    }
    let lineStart = this.scanned
    let newline = this.block.indexOf("\n", lineStart)
    while (newline !== -1) {
      if (withoutCarriageReturn(this.block.slice(lineStart, newline)) === this.closing) {
        const result = parseToolBlock(this.block.slice(0, lineStart))
        if (result.ok) {
          events.push({ type: "tool_calls", calls: result.calls })
          this.state = "after"
          this.dropped += this.block.length - (newline + 1)
          this.block = ""
          return
        }
        if (!result.retryable) {
          this.failBlock(result.reason, events)
          return
        }
      }
      lineStart = newline + 1
      newline = this.block.indexOf("\n", lineStart)
    }
    this.scanned = lineStart
  }

  private failBlock(reason: string, events: SplitterEvent[]): void {
    events.push({ type: "text", text: `${this.opening}\n${this.block}` })
    this.invalidReason = reason
    this.block = ""
    this.state = "passthrough"
  }
}
