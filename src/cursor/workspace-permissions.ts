import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { AdapterError } from "../openai/errors.js"
import { StartupError } from "../startup-error.js"

export type PlatformPaths = { home: string; realHome: string; platform: NodeJS.Platform }
export type PermissionsFile = { permissions: { allow: string[]; deny: string[] } }

export const deniedReadRoots = ({ home, realHome, platform }: PlatformPaths): string[] => {
  const roots = new Set([home, realHome])
  if (platform === "darwin") {
    roots.add(`/System/Volumes/Data${home}`)
    roots.add(`/System/Volumes/Data${realHome}`)
  }
  roots.add("/etc")
  roots.add("/root")
  if (platform === "darwin") {
    roots.add("/private/etc")
    roots.add("/System/Volumes/Data/private/etc")
  }
  return [...roots]
}

// Deny rules always win over allow rules in Cursor, and allow rules do not restrict unlisted reads, so the file has no allow rules.
export const buildPermissions = (paths: PlatformPaths): PermissionsFile => ({
  permissions: {
    allow: [],
    deny: [
      "Shell(*)",
      "Write(**)",
      "Write(/**)",
      "WebFetch(*)",
      "Mcp(*:*)",
      "Read(~/**)",
      ...deniedReadRoots(paths).map((root) => `Read(${root}/**)`),
    ],
  },
})

export const permissionsFileText = (paths: PlatformPaths): string => `${JSON.stringify(buildPermissions(paths), null, 2)}\n`

const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

// SECURITY-REVIEW: file-system access on a configured path; symbolic links are rejected along the path.
export const assertNoSymlinks = async (path: string): Promise<void> => {
  let current: string = sep
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (info.isSymbolicLink()) throw new StartupError(`The workspace path must not contain symbolic links: ${current}`)
  }
}

const ensurePrivateDirectory = async (path: string, uid: number, label: string): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new StartupError(`${label} must be a real folder: ${path}`)
  if (info.uid !== uid) throw new StartupError(`${label} must be owned by the adapter's user: ${path}`)
  if ((info.mode & 0o777) !== 0o700) throw new StartupError(`${label} must have mode 0700: ${path}`)
}

const writePermissionsFile = async (workspaceDir: string, text: string): Promise<void> => {
  const folder = join(workspaceDir, ".cursor")
  const temp = join(folder, `cli.json.${process.pid}.tmp`)
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, join(folder, "cli.json"))
}

// SECURITY-REVIEW: file-system access on a configured path; denied folders are checked and owner/mode are verified.
export const prepareWorkspace = async (input: { workspaceDir: string; paths: PlatformPaths; uid: number }): Promise<string> => {
  const workspace = resolve(input.workspaceDir)
  if (!isAbsolute(input.workspaceDir)) throw new StartupError("CURSOR2OPENAI_WORKSPACE_DIR must be an absolute path")
  await assertNoSymlinks(workspace)
  for (const root of deniedReadRoots(input.paths)) {
    if (isInside(workspace, root)) {
      throw new StartupError(`The workspace folder must not be inside ${root}, because the permissions file denies reads there`)
    }
  }
  try {
    await mkdir(workspace, { mode: 0o700 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EACCES") {
      throw new StartupError(`Cannot create the workspace folder ${workspace}. Create it once with: sudo install -d -o "$USER" -m 700 ${workspace}`)
    }
    if (code !== "EEXIST") throw error
  }
  await ensurePrivateDirectory(workspace, input.uid, "The workspace folder")
  if ((await realpath(workspace)) !== workspace) throw new StartupError("The workspace folder's real path must equal the configured path")
  await ensurePrivateDirectory(join(workspace, ".cursor"), input.uid, "The workspace .cursor folder")
  await ensurePrivateDirectory(join(workspace, "attachments"), input.uid, "The workspace attachments folder")
  const text = permissionsFileText(input.paths)
  await writePermissionsFile(workspace, text)
  return text
}

const ensureRealFolder = async (path: string): Promise<void> => {
  const info = await lstat(path).catch(() => undefined)
  if (!info) {
    await mkdir(path, { mode: 0o700 })
    return
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AdapterError(503, "service_unavailable", "The adapter workspace is not in a safe state")
  }
}

export const ensureWorkspaceReady = async (workspaceDir: string, expectedPermissions: string): Promise<void> => {
  await ensureRealFolder(join(workspaceDir, "attachments"))
  await ensureRealFolder(join(workspaceDir, ".cursor"))
  const current = await readFile(join(workspaceDir, ".cursor", "cli.json"), "utf8").catch(() => undefined)
  if (current !== expectedPermissions) await writePermissionsFile(workspaceDir, expectedPermissions)
}
