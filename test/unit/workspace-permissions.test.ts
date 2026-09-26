import assert from "node:assert/strict"
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
  buildPermissions,
  ensureWorkspaceReady,
  permissionsFileText,
  prepareWorkspace,
} from "../../src/cursor/workspace-permissions.js"
import { AdapterError } from "../../src/openai/errors.js"
import { makeTempDir } from "../helpers/temp-dir.js"

const uid = process.getuid?.() ?? 0
const paths = { home: "/nonexistent-home-c2o", realHome: "/nonexistent-home-c2o", platform: "linux" as const }
let dir: { path: string; cleanup(): Promise<void> }
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => dir.cleanup())

test("Linux rules deny tools, writes, and secret folders", () => {
  assert.deepEqual(buildPermissions({ home: "/home/u", realHome: "/home/u", platform: "linux" }), {
    permissions: {
      allow: [],
      deny: ["Shell(*)", "Write(**)", "Write(/**)", "WebFetch(*)", "Mcp(*:*)", "Read(~/**)", "Read(/home/u/**)", "Read(/etc/**)", "Read(/root/**)"],
    },
  })
})

test("macOS rules add every home and /etc spelling", () => {
  const deny = buildPermissions({ home: "/Users/u", realHome: "/Volumes/Home/u", platform: "darwin" }).permissions.deny
  for (const rule of [
    "Read(/Users/u/**)",
    "Read(/Volumes/Home/u/**)",
    "Read(/System/Volumes/Data/Users/u/**)",
    "Read(/private/etc/**)",
    "Read(/System/Volumes/Data/private/etc/**)",
  ]) {
    assert.ok(deny.includes(rule), rule)
  }
})

test("prepareWorkspace creates the folders and the permissions file", async () => {
  const workspace = join(dir.path, "ws")
  const text = await prepareWorkspace({ workspaceDir: workspace, paths, uid })
  assert.equal(text, permissionsFileText(paths))
  for (const folder of [workspace, join(workspace, ".cursor"), join(workspace, "attachments")]) {
    assert.equal((await stat(folder)).mode & 0o777, 0o700, folder)
  }
  assert.equal(await readFile(join(workspace, ".cursor", "cli.json"), "utf8"), text)
})

test("prepareWorkspace refuses a workspace inside a denied folder", async () => {
  await assert.rejects(
    prepareWorkspace({ workspaceDir: join(dir.path, "ws"), paths: { ...paths, home: dir.path, realHome: dir.path }, uid }),
    /must not be inside/,
  )
})

test("prepareWorkspace refuses symbolic links in the path", async () => {
  await mkdir(join(dir.path, "real"))
  await symlink(join(dir.path, "real"), join(dir.path, "link"))
  await assert.rejects(prepareWorkspace({ workspaceDir: join(dir.path, "link", "ws"), paths, uid }), /symbolic links/)
})

test("prepareWorkspace refuses the wrong mode or owner", async () => {
  const workspace = join(dir.path, "ws")
  await mkdir(workspace)
  await chmod(workspace, 0o755)
  await assert.rejects(prepareWorkspace({ workspaceDir: workspace, paths, uid }), /mode 0700/)
  await chmod(workspace, 0o700)
  await assert.rejects(prepareWorkspace({ workspaceDir: workspace, paths, uid: uid + 1 }), /owned by/)
})

test("prepareWorkspace shows the setup command when the parent folder is missing", async () => {
  await assert.rejects(prepareWorkspace({ workspaceDir: join(dir.path, "missing", "ws"), paths, uid }), /sudo install -d/)
})

test("ensureWorkspaceReady restores a changed or deleted permissions file and a missing attachments folder", async () => {
  const workspace = join(dir.path, "ws")
  const text = await prepareWorkspace({ workspaceDir: workspace, paths, uid })
  const file = join(workspace, ".cursor", "cli.json")
  await writeFile(file, "{}")
  await ensureWorkspaceReady(workspace, text)
  assert.equal(await readFile(file, "utf8"), text)
  await rm(file)
  await rm(join(workspace, "attachments"), { recursive: true })
  await ensureWorkspaceReady(workspace, text)
  assert.equal(await readFile(file, "utf8"), text)
  assert.ok((await stat(join(workspace, "attachments"))).isDirectory())
})

test("ensureWorkspaceReady refuses a symbolic link in place of attachments", async () => {
  const workspace = join(dir.path, "ws")
  const text = await prepareWorkspace({ workspaceDir: workspace, paths, uid })
  await rm(join(workspace, "attachments"), { recursive: true })
  await symlink(dir.path, join(workspace, "attachments"))
  await assert.rejects(ensureWorkspaceReady(workspace, text), (error: unknown) => error instanceof AdapterError && error.status === 503)
})
