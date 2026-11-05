#!/usr/bin/env bun
// Classifies a PR's artifact change for ship-check's verification step: which files under the
// profile's artifact paths changed between two commits, and whether every change fits an exemption
// class the profile selects. The classes are defined in the vault note Reference/live-test-evidence.
// A file the script cannot prove exempt is an artifact change; a git failure exits non-zero.
import { execFileSync } from "node:child_process"
import { basename } from "node:path"
import { parseArgs } from "node:util"

export type ExemptClass = "dependency" | "digest" | "action" | "comment" | "scripts"

export type GateInput = {
  repo: string
  from: string
  to: string
  /** `pr` compares the merge base with the head (`from...to`); `tested` compares two trees (`from to`). */
  range: "pr" | "tested"
  pathspecs: readonly string[]
  auditPathspecs: readonly string[]
  exempt: readonly ExemptClass[]
  imageScripts: readonly string[]
  liveTestPackages: readonly string[]
}

export type FileVerdict = { path: string; exemptAs: ExemptClass | undefined; reason: string }

export type GateResult = {
  outcome: "no artifact change" | "exempt" | "artifact change" | "local change"
  word: string
  files: FileVerdict[]
}

export class GitError extends Error {}

const EXEMPT_CLASSES: readonly ExemptClass[] = ["dependency", "digest", "action", "comment", "scripts"]
const DEPENDENCY_MAPS: readonly string[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]
// npm runs these on `npm ci` (`dependencies` after it changes node_modules), so an edit to one changes the image build.
const LIFECYCLE_KEYS: readonly string[] = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "dependencies"]
// A changed line of a `-U0` diff body, read after the first hunk header so the `---`/`+++` file headers are skipped.
const CHANGED_LINE = /^[+-]/
// `npm:<package>@<range>` installs another package under the key's name: group 1 is that package.
const NPM_ALIAS = /^npm:(@?[^@]+)/
// `@sha256:<hex>` inside a FROM line.
const DIGEST = /@sha256:[0-9a-f]+/
// A Dockerfile FROM instruction.
const FROM_LINE = /^\s*FROM\s+\S+/
// A workflow `uses:` line: group 1 is the action, group 2 its version.
const USES_LINE = /^\s*-?\s*uses:\s*([^@\s]+)@(\S+)/
const LOADERS: Readonly<Record<string, "ts" | "tsx" | "js" | "jsx">> = { ".ts": "ts", ".mts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".jsx": "jsx" }

type Loader = "ts" | "tsx" | "js" | "jsx"
type JsonObject = Record<string, unknown>
type LinePair = { removed: string; added: string }
/** An exemption class, or the reason the file is an artifact change. */
type Verdict = ExemptClass | { reason: string }

const isExemptClass = (value: string): value is ExemptClass => EXEMPT_CLASSES.some((name) => name === value)

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

const git = (repo: string, args: readonly string[]): string => {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    const stderr = isJsonObject(error) && typeof error.stderr === "string" ? error.stderr : ""
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`)
  }
}

const changedFiles = (input: GateInput, pathspecs: readonly string[]): string[] => {
  if (pathspecs.length === 0) return []
  const range = input.range === "pr" ? [`${input.from}...${input.to}`] : [input.from, input.to]
  const output = git(input.repo, ["diff", "--name-only", ...range, "--", ...pathspecs])
  return output.split("\n").filter((line) => line.length > 0)
}

const fileAt = (repo: string, commit: string, path: string): string | undefined => {
  try {
    return execFileSync("git", ["-C", repo, "show", `${commit}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
}

/** The commit holding a file's old content: the merge base in `pr` range, `from` itself in `tested` range. */
const oldCommit = (input: GateInput): string => {
  if (input.range === "tested") return input.from
  return git(input.repo, ["merge-base", input.from, input.to]).trim()
}

const parseJson = (text: string | undefined): JsonObject | undefined => {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isJsonObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const withoutKeys = (object: JsonObject, keys: readonly string[]): JsonObject => {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isJsonObject(value)) return value
  return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, sortKeys(value[key])]))
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

const mapOf = (object: JsonObject, key: string): JsonObject => {
  const value = object[key]
  return isJsonObject(value) ? value : {}
}

/** The package an `npm:` alias spec installs; undefined for any other spec. */
const aliasTarget = (spec: unknown): string | undefined => (typeof spec === "string" ? NPM_ALIAS.exec(spec)?.[1] : undefined)

/**
 * Returns why the dependency maps are not a plain version bump, or undefined when they are. An override pins a
 * package the tree already holds, so an `overrides` entry added or removed with a version string is a bump too.
 */
const dependencyBumpProblem = (before: JsonObject, after: JsonObject, liveTestPackages: readonly string[]): string | undefined => {
  for (const mapName of DEPENDENCY_MAPS) {
    const oldMap = mapOf(before, mapName)
    const newMap = mapOf(after, mapName)
    const oldKeys = Object.keys(oldMap).toSorted()
    const newKeys = Object.keys(newMap).toSorted()
    if (mapName !== "overrides" && oldKeys.join("\n") !== newKeys.join("\n")) return `${mapName} adds or removes a package`
    for (const name of new Set([...oldKeys, ...newKeys])) {
      // A nested override (an object) that did not change compares by value, not by reference.
      if (sameJson(oldMap[name], newMap[name])) continue
      const changed = name in newMap ? newMap[name] : oldMap[name]

      if (typeof changed !== "string") return `${mapName}.${name} is not a version string`
      if (liveTestPackages.includes(name)) return `${name} is a live-test package`
      if (aliasTarget(oldMap[name]) !== aliasTarget(newMap[name])) return `${mapName}.${name} changes the package it installs`
    }
  }
  return undefined
}

const isImageScript = (key: string, imageScripts: readonly string[]): boolean => {
  if (LIFECYCLE_KEYS.includes(key)) return true
  return imageScripts.some((script) => key === script || key === `pre${script}` || key === `post${script}`)
}

const classifyPackageJson = (before: JsonObject | undefined, after: JsonObject | undefined, input: GateInput): Verdict => {
  if (!before || !after) return { reason: "package.json unreadable at one side" }
  const restBefore = withoutKeys(before, DEPENDENCY_MAPS)
  const restAfter = withoutKeys(after, DEPENDENCY_MAPS)
  if (sameJson(restBefore, restAfter)) {
    const problem = dependencyBumpProblem(before, after, input.liveTestPackages)
    return problem ? { reason: problem } : "dependency"
  }
  if (!sameJson(withoutKeys(restBefore, ["scripts"]), withoutKeys(restAfter, ["scripts"]))) return { reason: "changes outside scripts and dependency maps" }
  if (!DEPENDENCY_MAPS.every((mapName) => sameJson(before[mapName], after[mapName]))) return { reason: "scripts and dependencies changed together" }
  const oldScripts = mapOf(before, "scripts")
  const newScripts = mapOf(after, "scripts")
  const changedKeys = [...new Set([...Object.keys(oldScripts), ...Object.keys(newScripts)])].filter((key) => oldScripts[key] !== newScripts[key])
  const imageKey = changedKeys.find((key) => isImageScript(key, input.imageScripts))
  return imageKey ? { reason: `scripts.${imageKey} runs during the image build` } : "scripts"
}

/**
 * The lockfile is exempt unless a live-test package's entry changed. npm keys each installed copy
 * `node_modules/<name>`, nested under its parent's path when it is not hoisted.
 */
const classifyLockfile = (input: GateInput, path: string, old: string): Verdict => {
  const before = mapOf(parseJson(fileAt(input.repo, old, path)) ?? {}, "packages")
  const after = mapOf(parseJson(fileAt(input.repo, input.to, path)) ?? {}, "packages")

  if (Object.keys(before).length === 0 || Object.keys(after).length === 0) return { reason: "package-lock.json has no packages map at one side" }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !sameJson(before[key], after[key]))
  const hit = input.liveTestPackages.find((name) => keys.some((key) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)))
  return hit ? { reason: `${hit} is a live-test package` } : "dependency"
}

/** Removed and added lines of a `-U0` diff, paired in order; undefined when their counts differ or nothing changed. */
const pairedLines = (input: GateInput, path: string, old: string): LinePair[] | undefined => {
  const lines = git(input.repo, ["diff", "-U0", old, input.to, "--", path]).split("\n")
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"))
  const body = firstHunk === -1 ? [] : lines.slice(firstHunk).filter((line) => CHANGED_LINE.test(line))
  const removed = body.filter((line) => line.startsWith("-")).map((line) => line.slice(1))
  const added = body.filter((line) => line.startsWith("+")).map((line) => line.slice(1))
  if (removed.length !== added.length || removed.length === 0) return undefined
  return removed.flatMap((line, index) => {
    const partner = added[index]
    return partner === undefined ? [] : [{ removed: line, added: partner }]
  })
}

const classifyDockerfile = (input: GateInput, path: string, old: string): Verdict => {
  const pairs = pairedLines(input, path, old)
  if (!pairs) return { reason: "lines added or removed, not paired" }
  for (const { removed, added } of pairs) {
    if (!FROM_LINE.test(removed) || !FROM_LINE.test(added)) return { reason: "a changed line is not a FROM line" }
    if (!DIGEST.test(removed) || !DIGEST.test(added)) return { reason: "a FROM line has no digest" }
    if (removed.replace(DIGEST, "") !== added.replace(DIGEST, "")) return { reason: "a FROM line changes more than its digest" }
  }
  return "digest"
}

const classifyWorkflow = (input: GateInput, path: string, old: string): Verdict => {
  const pairs = pairedLines(input, path, old)
  if (!pairs) return { reason: "lines added or removed, not paired" }
  for (const { removed, added } of pairs) {
    const before = USES_LINE.exec(removed)
    const after = USES_LINE.exec(added)
    if (!before || !after) return { reason: "a changed line is not a uses: line" }
    if (before[1] !== after[1]) return { reason: `the action changes from ${before[1]} to ${after[1]}` }
    if (before[2] === after[2]) return { reason: "a uses: line changes outside its version" }
  }
  return "action"
}

// With elimination or shaking on, two sources that differ only in code the transpiler drops would
// compare equal, so a real change could pass as comment-only; every such option stays off. No
// macros are configured, so the PR's text is parsed, never run.
const TRANSPILE_OPTIONS = {
  deadCodeElimination: false,
  treeShaking: false,
  trimUnusedImports: false,
  minifyWhitespace: false,
  inline: false,
} as const

const stripComments = (text: string, loader: Loader): string | undefined => {
  try {
    return new Bun.Transpiler({ loader, ...TRANSPILE_OPTIONS }).transformSync(text)
  } catch {
    return undefined
  }
}

const classifyCode = (input: GateInput, path: string, old: string, loader: Loader): Verdict => {
  const before = fileAt(input.repo, old, path)
  const after = fileAt(input.repo, input.to, path)
  // An empty file is valid content, so the check is for a missing file, not a falsy one.
  if (before === undefined || after === undefined) return { reason: "file unreadable at one side" }
  const strippedBefore = stripComments(before, loader)
  const strippedAfter = stripComments(after, loader)
  if (strippedBefore === undefined || strippedAfter === undefined) return { reason: "the transpiler could not parse the file" }
  return strippedBefore === strippedAfter ? "comment" : { reason: "code changed beyond comments" }
}

const classifyFile = (input: GateInput, path: string, old: string): FileVerdict => {
  const name = basename(path)
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ""
  const loader = LOADERS[extension]
  const decide = (): Verdict => {
    if (name === "package.json") return classifyPackageJson(parseJson(fileAt(input.repo, old, path)), parseJson(fileAt(input.repo, input.to, path)), input)
    if (name === "package-lock.json") return classifyLockfile(input, path, old)
    if (name.startsWith("Dockerfile")) return classifyDockerfile(input, path, old)
    if (path.startsWith(".github/workflows/")) return classifyWorkflow(input, path, old)
    if (loader) return classifyCode(input, path, old, loader)
    return { reason: "no deterministic class for this file type; judge the hunk, deploy when unsure" }
  }
  const verdict = decide()
  if (typeof verdict !== "string") return { path, exemptAs: undefined, reason: verdict.reason }
  if (!input.exempt.includes(verdict)) return { path, exemptAs: undefined, reason: `${verdict} is not a selected exemption` }
  return { path, exemptAs: verdict, reason: verdict }
}

export const classify = (input: GateInput): GateResult => {
  const artifact = changedFiles(input, input.pathspecs)
  if (artifact.length === 0) {
    const audit = changedFiles(input, input.auditPathspecs)
    if (audit.length === 0) return { outcome: "no artifact change", word: "no artifact change", files: [] }
    const files = audit.map((path) => ({ path, exemptAs: undefined, reason: "audit path" }))
    return { outcome: "local change", word: `local change (${audit.length} files)`, files }
  }
  const old = oldCommit(input)
  const files = artifact.map((path) => classifyFile(input, path, old))
  const changed = files.filter((file) => !file.exemptAs)
  if (changed.length > 0) {
    return { outcome: "artifact change", word: `artifact change (${changed.length} files: ${changed.map((file) => file.path).join(", ")})`, files }
  }
  const classes = [...new Set(files.flatMap((file) => (file.exemptAs ? [file.exemptAs] : [])))].toSorted()
  return { outcome: "exempt", word: `exempt (${classes.join(", ")})`, files }
}

const parseExempt = (values: readonly string[]): ExemptClass[] => {
  const names = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value.length > 0)
  const unknown = names.find((name) => !isExemptClass(name))
  if (unknown) throw new Error(`unknown exemption class: ${unknown}`)
  return names.filter(isExemptClass)
}

const main = (): void => {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      range: { type: "string", default: "pr" },
      pathspec: { type: "string", multiple: true, default: [] },
      "audit-pathspec": { type: "string", multiple: true, default: [] },
      exempt: { type: "string", multiple: true, default: [] },
      "image-script": { type: "string", multiple: true, default: [] },
      "live-test-package": { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
    },
  })
  if (!values.repo || !values.from || !values.to) throw new Error("--repo, --from and --to are required")
  if (values.range !== "pr" && values.range !== "tested") throw new Error("--range must be pr or tested")
  // `--from` can come from a PR body; a leading dash would reach git as an option such as `--output=<file>`.
  if (values.from.startsWith("-") || values.to.startsWith("-")) throw new Error("--from and --to must name commits, not options")
  const result = classify({
    repo: values.repo,
    from: values.from,
    to: values.to,
    range: values.range,
    pathspecs: values.pathspec,
    auditPathspecs: values["audit-pathspec"],
    exempt: parseExempt(values.exempt),
    imageScripts: values["image-script"],
    liveTestPackages: values["live-test-package"],
  })
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.word}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(error instanceof GitError ? 2 : 1)
  }
}
