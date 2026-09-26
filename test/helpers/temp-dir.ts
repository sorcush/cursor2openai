import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const makeTempDir = async (): Promise<{ path: string; cleanup(): Promise<void> }> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "c2o-test-")))
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}
