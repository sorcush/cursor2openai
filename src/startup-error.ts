export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartupError"
  }
}
