import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { safePath } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/direct-root"
import { requireDPath } from "./contracts"
import { sha256Bytes, sha256Text } from "../hash"

export const ProductionGitRequest = Schema.Struct({
  cwd: Schema.String,
  argv: Schema.Array(Schema.String),
  stdin: Schema.optionalKey(Schema.String),
})
export type ProductionGit = Readonly<{
  execute(
    input: typeof ProductionGitRequest.Type,
    signal: AbortSignal,
  ): Promise<{ exit: number; stdout: string; stderr: string; truncated: boolean }>
  close(): Promise<void>
}>

/** A finite original-Git transport. All Git reads use private, controller-frozen
 * public bytes, never the agent-writable config, hooks, index or object store. */
export async function openProductionGit(input: {
  workspace: string
  snapshotsRoot: string
  cacheRoot: string
  git: { path: string; sha256: string }
  states: readonly (readonly { path: string; bytes: Uint8Array }[])[]
  guard(): Promise<void>
}): Promise<ProductionGit> {
  for (const root of [input.workspace, input.snapshotsRoot, input.cacheRoot]) requireDPath(root)
  await directRoot(input.workspace)
  await directRoot(input.snapshotsRoot)
  await directRoot(path.dirname(input.cacheRoot))
  const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep)
  if (
    inside(input.workspace, input.cacheRoot) ||
    inside(input.cacheRoot, input.workspace) ||
    inside(input.snapshotsRoot, input.cacheRoot) ||
    inside(input.cacheRoot, input.snapshotsRoot)
  )
    throw Error("TASK24_GIT_ROOTS")
  const states = input.states.map((files) =>
    files
      .map((f) => {
        safePath(f.path)
        if (
          /(?:^|\/)(?:\.git|private|oracle|gold|node_modules|\.env(?:\.|$))(?:\/|$)/i.test(f.path) ||
          f.bytes.byteLength > 8388608
        )
          throw Error("TASK24_GIT_PUBLIC_STATE")
        return { path: f.path, bytes: Buffer.from(f.bytes), sha256: sha256Bytes(f.bytes) }
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  )
  if (
    !states.length ||
    states.length > 16 ||
    states.some(
      (files) =>
        !files.length || files.length > 20000 || new Set(files.map((f) => f.path.toLowerCase())).size !== files.length,
    ) ||
    states.flat().reduce((n, f) => n + f.bytes.length, 0) > 67108864
  )
    throw Error("TASK24_GIT_PUBLIC_STATE")
  const signature = (files: readonly { path: string; sha256: string }[]) =>
    sha256Text(canonicalJson(files.map((f) => [f.path, f.sha256])))
  async function pinGit() {
    const before = await fs.lstat(input.git.path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > 33554432 ||
      (await fs.realpath(input.git.path)).toLowerCase() !== input.git.path.toLowerCase() ||
      sha256Bytes(await fs.readFile(input.git.path)) !== input.git.sha256
    )
      throw Error("TASK24_GIT_EXECUTABLE")
  }
  await input.guard()
  await pinGit()
  const publicGit = path.join(input.workspace, ".git")
  await directRoot(publicGit)
  await fs.mkdir(input.cacheRoot)
  const identity = await fs.lstat(input.cacheRoot, { bigint: true })
  const nonce = randomBytes(32).toString("hex")
  await fs.writeFile(path.join(input.cacheRoot, "owner.json"), canonicalJson({ nonce }), { flag: "wx" })
  const source = path.join(input.cacheRoot, "source.git")
  const empty = path.join(input.cacheRoot, "empty-config")
  const stores = new Map<string, string>([[publicGit, source]])
  const trees = new Set<string>()
  const objects = new Set<string>()
  let closed = false,
    queued = 0
  let tail: Promise<unknown> = Promise.resolve()
  async function retire() {
    const current = await fs.lstat(input.cacheRoot, { bigint: true })
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.birthtimeNs !== identity.birthtimeNs ||
      (await fs.realpath(input.cacheRoot)) !== input.cacheRoot ||
      (await fs.readFile(path.join(input.cacheRoot, "owner.json"), "utf8")) !== canonicalJson({ nonce })
    )
      throw Error("TASK24_GIT_RETIREMENT_UNCERTAIN")
    await walk(input.cacheRoot)
    await fs.rm(input.cacheRoot, { recursive: true })
  }
  try {
    await fs.mkdir(source)
    await fs.writeFile(empty, "", { flag: "wx" })
    // Copy only Git's inert bounded data from the fresh public repository.
    // Config, hooks, alternates, replacement refs and linked worktrees never cross.
    const metadata = await walk(publicGit)
    for (const f of metadata) {
      if (
        !/^(?:HEAD|index|packed-refs|refs\/heads\/[A-Za-z0-9._/-]+|objects\/[a-f0-9]{2}\/[a-f0-9]{38}|objects\/pack\/pack-[a-f0-9]{40}\.(?:pack|idx|rev)|info\/exclude)$/.test(
          f.path,
        )
      )
        continue
      const target = path.join(source, f.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, f.bytes, { flag: "wx" })
    }
    for (const dir of ["objects", "refs"]) await fs.mkdir(path.join(source, dir), { recursive: true })
    await fs.writeFile(
      path.join(source, "config"),
      "[core]\nrepositoryformatversion=0\nbare=false\nfilemode=false\nautocrlf=false\nfsmonitor=false\n",
      { flag: "wx" },
    )
    const prepared: { root: string; signature: string }[] = []
    for (const [i, files] of states.entries()) {
      const root = path.join(input.cacheRoot, "state-" + i)
      await fs.mkdir(root)
      for (const f of files) {
        const target = path.join(root, f.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, f.bytes, { flag: "wx" })
        await fs.utimes(target, 1700000000 + i * 10, 1700000000 + i * 10)
      }
      prepared.push({ root, signature: signature(files) })
    }
    async function execute(raw: typeof ProductionGitRequest.Type, signal: AbortSignal) {
      signal.throwIfAborted()
      if (closed) throw Error("TASK24_GIT_CLOSED")
      await input.guard()
      await pinGit()
      signal.throwIfAborted()
      if (
        raw.cwd !== input.workspace ||
        raw.argv.length > 32 ||
        raw.argv.some((arg) => !arg || arg.includes("\0") || arg.length > 4096)
      )
        throw Error("TASK24_GIT_INVOCATION")
      const live = await walk(input.workspace, true)
      const current = prepared.find((state) => state.signature === signature(live))
      if (!current) throw Error("TASK24_GIT_PUBLIC_STATE")
      signal.throwIfAborted()
      const paired = raw.argv[0] === "--git-dir"
      const requested = paired ? raw.argv[1]! : publicGit
      if (paired && (raw.argv[2] !== "--work-tree" || raw.argv[3] !== input.workspace))
        throw Error("TASK24_GIT_INVOCATION")
      const prefix = [
        "--no-optional-locks",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
      ]
      const args = raw.argv.slice(
        paired ? 4 : canonicalJson(raw.argv.slice(0, prefix.length)) === canonicalJson(prefix) ? prefix.length : 0,
      )
      const shadow = requested !== publicGit
      if (
        shadow &&
        (!inside(input.snapshotsRoot, requested) ||
          path.relative(input.snapshotsRoot, requested).split(path.sep).length !== 2 ||
          path
            .relative(input.snapshotsRoot, requested)
            .split(path.sep)
            .some((p) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(p)))
      )
        throw Error("TASK24_GIT_STORE")
      const bytes = raw.stdin === undefined ? undefined : Buffer.from(raw.stdin, "base64")
      if (bytes && (bytes.toString("base64") !== raw.stdin || bytes.length > 1048576)) throw Error("TASK24_GIT_STDIN")
      const same = (...items: string[]) => canonicalJson(args) === canonicalJson(items)
      const relative = (p: string | undefined) => {
        if (!p) return false
        if (p === ".") return true
        try {
          safePath(p)
          return !p.split("/").some((s) => s.startsWith(":"))
        } catch {
          return false
        }
      }
      const tree = (id: string | undefined) => id !== undefined && trees.has(id)
      const query =
        !paired &&
        (same("rev-parse", "--show-toplevel") ||
          same("rev-parse", "--git-dir") ||
          same("rev-parse", "--git-common-dir") ||
          same("rev-parse", "HEAD") ||
          same("rev-list", "--max-parents=0", "HEAD") ||
          same("remote", "get-url", "origin") ||
          same("symbolic-ref", "--quiet", "--short", "HEAD") ||
          same("worktree", "list", "--porcelain") ||
          same("remote") ||
          same("for-each-ref", "--format=%(refname:short)", "refs/heads") ||
          same("config", "init.defaultBranch"))
      const ignores = same("check-ignore", "--no-index", "--stdin", "-z")
      const config =
        args.length === 3 &&
        args[0] === "config" &&
        new Map([
          ["core.autocrlf", "false"],
          ["core.longpaths", "true"],
          ["core.symlinks", "true"],
          ["core.fsmonitor", "false"],
          ["feature.manyFiles", "true"],
          ["index.version", "4"],
          ["index.threads", "true"],
          ["core.untrackedCache", "true"],
        ]).get(args[1]!) === args[2]
      const stage =
        same("add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul") ||
        same("rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul")
      const list =
        (args.length === 5 &&
          args[0] === "diff-files" &&
          canonicalJson(args.slice(1, 4)) === canonicalJson(["--name-only", "-z", "--"]) &&
          relative(args[4])) ||
        (args.length === 6 &&
          canonicalJson(args.slice(0, 5)) ===
            canonicalJson(["ls-files", "--others", "--exclude-standard", "-z", "--"]) &&
          relative(args[5]))
      const entryList =
        args.length === 8 &&
        canonicalJson(args.slice(0, 5)) === canonicalJson(["ls-tree", "-r", "-z", "-l", "--full-tree"]) &&
        tree(args[5]) &&
        args[6] === "--" &&
        relative(args[7])
      const blob = args.length === 3 && args[0] === "cat-file" && args[1] === "blob" && objects.has(args[2]!)
      const show =
        args.length === 2 &&
        args[0] === "show" &&
        tree(args[1]?.split(":")[0]) &&
        relative(args[1]?.slice(args[1].indexOf(":") + 1)) &&
        args[1]!.includes(":")
      const diff =
        (args.length === 5 &&
          same("diff", "--name-only", "-z", args[3]!, args[4]!) &&
          tree(args[3]) &&
          tree(args[4])) ||
        (args.length === 7 &&
          args[0] === "diff" &&
          /^(?:--name-status|--numstat|--unified=\d{1,3})$/.test(args[1]!) &&
          args[2] === "--no-renames" &&
          tree(args[3]) &&
          tree(args[4]) &&
          args[5] === "--" &&
          relative(args[6]))
      if (
        !(
          query ||
          (paired &&
            (ignores ||
              (shadow &&
                (same("init") || config || stage || list || entryList || blob || show || diff || same("write-tree")))))
        )
      )
        throw Error("TASK24_GIT_OPERATION")
      if (stage || ignores) {
        const text = bytes?.toString("utf8")
        if (
          !text?.endsWith("\0") ||
          text
            .slice(0, -1)
            .split("\0")
            .some((p) => !relative(p) || !states.some((files) => files.some((f) => f.path === p)))
        )
          throw Error("TASK24_GIT_STDIN")
      } else if (bytes !== undefined) throw Error("TASK24_GIT_STDIN")
      if (!stores.has(requested)) {
        if (!same("init")) throw Error("TASK24_GIT_STORE")
        const target = path.join(input.cacheRoot, "store-" + sha256Text(requested))
        await fs.mkdir(target)
        stores.set(requested, target)
      }
      const store = stores.get(requested)!
      const env = {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
        HOME: input.cacheRoot,
        USERPROFILE: input.cacheRoot,
        APPDATA: input.cacheRoot,
        LOCALAPPDATA: input.cacheRoot,
        TEMP: input.cacheRoot,
        TMP: input.cacheRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: empty,
        GIT_CONFIG_SYSTEM: empty,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_LFS_SKIP_SMUDGE: "1",
      }
      signal.throwIfAborted()
      const child = Bun.spawn(
        [
          input.git.path,
          "-c",
          "core.hooksPath=" + path.join(input.cacheRoot, "no-hooks"),
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.attributesFile=" + empty,
          "-c",
          "protocol.allow=never",
          "--git-dir",
          store,
          "--work-tree",
          current.root,
          ...args,
        ],
        {
          // Native DLL lookup must begin in controller-owned metadata, not
          // candidate file bytes; Git receives its explicit private worktree.
          cwd: input.cacheRoot,
          env,
          stdin: bytes === undefined ? "ignore" : bytes,
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      const abort = () => child.kill()
      const timer = setTimeout(abort, 15000)
      signal.addEventListener("abort", abort, { once: true })
      async function collect(stream: ReadableStream<Uint8Array>) {
        const chunks: Uint8Array[] = []
        let size = 0,
          truncated = false
        const reader = stream.getReader()
        try {
          for (;;) {
            const item = await reader.read()
            if (item.done) break
            if (size + item.value.length > 2097152) {
              truncated = true
              child.kill()
              break
            }
            chunks.push(item.value)
            size += item.value.length
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        return { bytes: Buffer.concat(chunks, size), truncated }
      }
      try {
        const [exit, stdout, stderr] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)])
        signal.throwIfAborted()
        await input.guard()
        signal.throwIfAborted()
        if (same("init") && exit === 0) {
          if (!shadow) throw Error("TASK24_GIT_STORE")
          await fs.mkdir(path.join(store, "objects", "info"), { recursive: true })
          await fs.writeFile(
            path.join(store, "objects", "info", "alternates"),
            path.join(source, "objects").replaceAll("\\", "/") + "\n",
          )
          if (!(await fs.lstat(path.join(store, "index")).catch(() => null)))
            await fs.copyFile(path.join(source, "index"), path.join(store, "index"))
        }
        if (same("write-tree") && exit === 0) {
          const id = stdout.bytes.toString("utf8").trim()
          if (!/^[a-f0-9]{40}$/.test(id)) throw Error("TASK24_GIT_TREE")
          trees.add(id)
        }
        if (entryList && exit === 0)
          for (const record of stdout.bytes.toString("utf8").split("\0")) {
            const match = /^(?:100644|100755) blob ([a-f0-9]{40})\s+\d+\t/.exec(record)
            if (match) objects.add(match[1]!)
          }
        const mapped = query
          ? stdout.bytes
              .toString("utf8")
              .replaceAll(current.root.replaceAll("\\", "/"), input.workspace.replaceAll("\\", "/"))
              .replaceAll(store.replaceAll("\\", "/"), publicGit.replaceAll("\\", "/"))
              .replaceAll(current.root, input.workspace)
              .replaceAll(store, publicGit)
          : undefined
        return {
          exit,
          stdout: (mapped === undefined ? stdout.bytes : Buffer.from(mapped)).toString("base64"),
          stderr: stderr.bytes.toString("base64"),
          truncated: stdout.truncated || stderr.truncated,
        }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
    }
    let closing: Promise<void> | undefined
    return {
      async execute(raw, signal) {
        const request = Schema.decodeUnknownSync(ProductionGitRequest)(structuredClone(raw), {
          onExcessProperty: "error",
        })
        if (closed || queued >= 16) throw Error("TASK24_GIT_BUSY")
        queued++
        const result = tail.then(() => execute(request, signal))
        tail = result.catch(() => {})
        try {
          return await result
        } finally {
          queued--
        }
      },
      close() {
        return (closing ??= (async () => {
          closed = true
          await tail
          await retire()
        })())
      },
    }
  } catch (cause) {
    await retire()
    throw cause
  }
}

async function walk(root: string, publicWorktree = false) {
  await directRoot(root)
  const files: { path: string; bytes: Buffer; sha256: string }[] = []
  let total = 0
  async function scan(directory: string) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name)
      const relative = path.relative(root, absolute).replaceAll("\\", "/")
      if (publicWorktree && relative === ".git") continue
      safePath(relative)
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink() || (await fs.realpath(absolute)) !== absolute) throw Error("TASK24_GIT_LINK")
      if (stat.isDirectory()) {
        await scan(absolute)
        continue
      }
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 8388608 ||
        files.length >= 20000 ||
        (total += stat.size) > 134217728
      )
        throw Error("TASK24_GIT_LIMIT")
      const bytes = await fs.readFile(absolute)
      const after = await fs.lstat(absolute)
      if (
        stat.dev !== after.dev ||
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs ||
        bytes.length !== stat.size
      )
        throw Error("TASK24_GIT_DRIFT")
      files.push({ path: relative, bytes, sha256: sha256Bytes(bytes) })
    }
  }
  await scan(root)
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
