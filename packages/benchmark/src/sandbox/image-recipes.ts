import { canonicalJson } from "../campaign/canonical"
import { freeze, safePath } from "../corpus/evaluation-profile"
import { sha256Bytes, sha256Text } from "../hash"
import type { TaskAdapterDefinition } from "../corpus/evaluation-catalogue"
import type { FileEntry } from "../corpus/manifest"

export type ImageRecipe = Readonly<{
  taskID: string
  family: TaskAdapterDefinition["publicFixtureTemplate"]
  sourceCommit: string
  image: string
  platform: string
  auditSha256: string
  lockfiles: readonly FileEntry[]
  install: { argv: readonly string[]; scriptSha256: string }
  build: { argv: readonly string[]; scriptSha256: string }
  capabilities: readonly string[]
  recipeSha256: string
}>
export function makeImageRecipe(input: {
  task: TaskAdapterDefinition
  sourceCommit: string
  sourceFiles: Readonly<Record<string, Uint8Array>>
  image: string
  platform: string
}): ImageRecipe {
  if (
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(input.image) ||
    !/^linux\/(amd64|arm64)$/.test(input.platform)
  )
    throw new TypeError("TASK24_LINUX_RECIPE_IDENTITY")
  const lockfiles = Object.entries(input.sourceFiles)
    .filter(([p]) =>
      /^starter\/(?:[a-zA-Z0-9._-]+\/)*(?:yarn\.lock|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml)$/.test(p),
    )
    .map(([p, b]) => ({ path: safePath(p.slice(8)), size: b.byteLength, sha256: sha256Bytes(b) }))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (input.task.stratum === "swebench-multimodal" && !lockfiles.length)
    throw new TypeError("TASK24_LINUX_LOCKFILE_MISSING")
  const pkg = input.sourceFiles["starter/package.json"]
    ? (JSON.parse(Buffer.from(input.sourceFiles["starter/package.json"]).toString("utf8")) as {
        scripts?: Record<string, unknown>
      })
    : {}
  const command = lockfiles.some((l) => l.path === "yarn.lock")
    ? ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"]
    : lockfiles.some((l) => /^bun\.lockb?$/.test(l.path))
      ? ["bun", "--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"]
      : lockfiles.some((l) => l.path === "package-lock.json")
        ? ["npm", "ci", "--ignore-scripts"]
        : []
  if (lockfiles.length && !command.length) throw new TypeError("TASK24_LINUX_LOCK_MANAGER_UNSUPPORTED")
  if (input.task.stratum === "swebench-multimodal" && typeof pkg.scripts?.build !== "string")
    throw new TypeError("TASK24_LINUX_BUILD_RECIPE_MISSING")
  const body = {
    taskID: input.task.taskID,
    family: input.task.publicFixtureTemplate,
    sourceCommit: input.sourceCommit,
    image: input.image,
    platform: input.platform,
    auditSha256: sha256Text(dependencyAuditSource()),
    lockfiles,
    install: { argv: command, scriptSha256: sha256Text(canonicalJson(command)) },
    build: {
      argv: input.task.stratum === "swebench-multimodal" ? ["bun", "--no-env-file", "run", "build"] : [],
      scriptSha256: sha256Text(typeof pkg.scripts?.build === "string" ? pkg.scripts.build : ""),
    },
    capabilities: [
      ...input.task.requiredCapabilities,
      ...(input.task.publicFixtureTemplate === "react-pdf" ? ["pdf-parser"] : []),
    ],
  }
  return freeze({ ...body, recipeSha256: sha256Text(canonicalJson(body)) })
}
export function verifyImageRecipe(recipe: ImageRecipe): ImageRecipe {
  const { recipeSha256, ...body } = recipe
  if (
    sha256Text(canonicalJson(body)) !== recipeSha256 ||
    !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(recipe.image) ||
    !/^linux\/(amd64|arm64)$/.test(recipe.platform) ||
    recipe.lockfiles.some((f) => !/^[a-f0-9]{64}$/.test(f.sha256))
  )
    throw new TypeError("TASK24_LINUX_RECIPE_DRIFT")
  return freeze(recipe)
}
/** Trusted image helper. It reads dependency bytes; it never imports package code. */
export function dependencyAuditSource() {
  return `import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const chunks=[];let inputBytes=0;for await(const chunk of process.stdin){inputBytes+=chunk.length;if(inputBytes>65536)throw Error('AUDIT_INPUT');chunks.push(chunk)}
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!Array.isArray(input.volumes)||input.volumes.length>512||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>8589934592)throw Error('AUDIT_INPUT');
const root=path.resolve(process.argv.at(-1)==='/opt/task24/audit.mjs'?'/workspace':process.argv.at(-1));
const rootReal=await fs.realpath(root),volumes=[];let total=0,count=0;
for(const volume of input.volumes){if(typeof volume.name!=='string'||typeof volume.target!=='string')throw Error('AUDIT_VOLUME');const target=path.resolve(volume.target);if(!target.startsWith(root+path.sep)||!((await fs.realpath(target)).startsWith(rootReal+path.sep)))throw Error('AUDIT_PATH');const entries=[];
async function walk(relative,depth){if(depth>64)throw Error('AUDIT_DEPTH');for(const name of (await fs.readdir(path.join(target,relative))).sort()){if(++count>200000)throw Error('AUDIT_COUNT');const rel=relative?relative+'/'+name:name,file=path.join(target,rel),stat=await fs.lstat(file);if(stat.isDirectory()){await walk(rel,depth+1);continue}if(stat.isSymbolicLink()){const link=await fs.readlink(file),real=await fs.realpath(file);if(!real.startsWith(target+path.sep))throw Error('AUDIT_LINK');entries.push({path:rel,sha256:hash(link),size:Buffer.byteLength(link),target:link});continue}if(!stat.isFile()||(total+=stat.size)>input.maxBytes)throw Error('AUDIT_FILE');entries.push({path:rel,sha256:hash(await fs.readFile(file)),size:stat.size})}}
await walk('',0);entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const stat=await fs.stat(target);volumes.push({name:volume.name,treeSha256:hash(JSON.stringify(entries)),fileID:stat.dev+':'+stat.ino+':'+stat.birthtimeMs})}
const tools=[];if(process.platform==='linux'){for(const [name,file] of [['node','/usr/local/bin/node'],['bun','/usr/local/bin/bun'],['pdf-parser','/usr/bin/pdftotext'],['pdf-raster','/usr/bin/pdftoppm']]){try{await fs.access(file);tools.push(name)}catch{}}}
const workerSha256=hash(await fs.readFile(new URL(import.meta.url)));process.stdout.write(JSON.stringify({platform:process.platform+'/'+(process.arch==='x64'?'amd64':process.arch),workerSha256,tools,volumes}));
`
}
