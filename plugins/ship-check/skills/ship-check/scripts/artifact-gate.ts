#!/usr/bin/env bun
// Classifies a PR's change for ship-check's verification step: which files under the artifact paths
// changed between two commits, and whether every change fits a selected exemption class. The project's
// verification profile (a section of its CLAUDE.local.md) supplies the path, exemption, script and package
// flags, and the caller the repo and the commits; GateInput documents each. A file the script cannot prove
// exempt is an artifact change. Exit codes: 0 classified, 2 git failure, 1 any other error.
import { execFileSync } from "node:child_process"
import { basename, extname } from "node:path"
import { parseArgs } from "node:util"

/**
 * The kinds of change that skip the live test:
 * - `dependency`: registry version bumps in package.json, or a package-lock.json change
 * - `digest`: Dockerfile FROM lines that change only their `@sha256:` digest
 * - `action`: workflow `uses:` lines that change only the action's version
 * - `comment`: JS or TS files whose transpiled output, `#!` line and "use strict" directives are unchanged
 * - `scripts`: package.json scripts the image build never runs
 */
const EXEMPT_CLASSES = ["dependency", "digest", "action", "comment", "scripts"] as const

export type ExemptClass = (typeof EXEMPT_CLASSES)[number]

export type GateInput = {
  repo: string
  from: string
  to: string
  /** `pr` compares the merge base with the head (`from...to`); `tested` compares two trees (`from to`). */
  range: "pr" | "tested"
  /** Artifact paths: the files the deployed image is built from. */
  pathspecs: readonly string[]
  /** Audit paths: code outside the image whose change local probes can check without a deploy. */
  auditPathspecs: readonly string[]
  exempt: readonly ExemptClass[]
  /** The package.json scripts the image build runs, such as the Dockerfile's `npm run build`. */
  imageScripts: readonly string[]
  /** Live-test packages: packages whose every version bump needs the live test. */
  liveTestPackages: readonly string[]
}

export type FileVerdict = { path: string; exemptAs: ExemptClass | undefined; reason: string }

export type GateResult = {
  /**
   * - `no artifact change`: nothing under the artifact or audit paths changed
   * - `exempt`: every changed artifact file fits a selected exemption class
   * - `artifact change`: an artifact file fits none, so the PR needs the live test
   * - `local change`: audit paths changed and no artifact file needs the live test, so local probes replace it
   */
  outcome: "no artifact change" | "exempt" | "artifact change" | "local change"
  /** The outcome with its counts and classes, as the step reports it: `artifact change (2 files: …)`. */
  summary: string
  files: FileVerdict[]
}

export class GitError extends Error {
  readonly stderr: string

  constructor(message: string, stderr: string) {
    super(message)
    this.stderr = stderr
  }
}

const DEPENDENCY_MAPS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
]
// Script names npm runs on `npm ci`, so an edit to one changes the image build. The `dependencies` script runs
// after node_modules changes; it is unrelated to the dependency map of the same name.
const LIFECYCLE_SCRIPTS: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
]
// A changed line of a `-U0` diff body, read after the first hunk header so the `---`/`+++` file headers are skipped.
const CHANGED_LINE = /^[+-]/
// A hunk header, `@@ -<start>[,<removed>] +<start>[,<added>] @@`: groups 1 and 2 are the two counts, and a
// count git leaves out is 1.
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/
// `npm:<package>@<range>` installs another package under the key's name: group 1 is that package.
const NPM_ALIAS = /^npm:(@?[^@]+)/
// A spec that resolves on the npm registry: a range, a tag, or an `npm:` alias with a range. Anything with a `:`,
// `/` or `#` beyond that, or a leading `.`, points outside the registry.
// - Matches: `^1.2.3`, `latest`, `1.x || 2.x`, `npm:@scope/pkg@^2`
// - Fails: `file:../pkg`, `..`, `github:owner/repo#ref`, `https://…/pkg.tgz`, `npm:pkg` (an alias with no range)
const REGISTRY_SPEC = /^(?!.*\s)(?!.*\.(tgz|tar|tar\.gz)$)(npm:@?[^@/#:]+(\/[^@/#:]+)?@)?(?!\.)[^:/#]*$/
// An overrides key may name a version, `<package>@<range>`: group 1 is the package.
const KEY_PACKAGE = /^(@?[^@]+)/
// Splits a script's command into the words that can name another script.
const COMMAND_WORD_BREAK = /[^\w:.@/-]+/
// `@sha256:<hex>` inside a FROM line.
const DIGEST = /@sha256:[0-9a-f]+/
// A Dockerfile FROM instruction.
const FROM_LINE = /^\s*FROM\s+\S+/
// A workflow `uses:` line: group 1 is the action, group 2 its version.
const USES_LINE = /^\s*-?\s*uses:\s*([^@\s]+)@(\S+)/

type Loader = "ts" | "tsx" | "js" | "jsx"
type JsonObject = Record<string, unknown>
type LinePair = { removed: string; added: string }
/** An exemption class, or the reason the file is an artifact change. */
type Verdict = ExemptClass | { reason: string }
/** A changed artifact file: its path and the commit that holds its old content. */
type ChangedFile = { input: GateInput; path: string; oldCommit: string }

const LOADERS: Readonly<Record<string, Loader>> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
}

const isExemptClass = (value: string): value is ExemptClass => EXEMPT_CLASSES.some((name) => name === value)

const isJsonObject = (value: unknown): value is JsonObject => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === "string"

// By default execFileSync fails once a child's output passes 1 MiB, and a large project's package-lock.json
// runs to several megabytes.
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024

const git = (repo: string, args: readonly string[]): string => {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      // PATH_ABSENT matches git's English messages, which a translated git prints in the user's language.
      env: { ...process.env, LC_ALL: "C" },
    })
  } catch (error) {
    const stderr = isJsonObject(error) && typeof error.stderr === "string" ? error.stderr : ""
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`, stderr)
  }
}

/** The files under the pathspecs that differ between the old commit and the head. */
const changedFiles = (input: GateInput, oldCommit: string, pathspecs: readonly string[]): string[] => {
  // With no pathspec after `--`, git diff would list every changed file in the repo.
  if (pathspecs.length === 0) return []

  const output = git(input.repo, ["diff", "--name-only", oldCommit, input.to, "--", ...pathspecs])
  return output.split("\n").filter((line) => line.length > 0)
}

// git's two messages for a path that is not in the tree at that commit; any other failure is a git failure.
const PATH_ABSENT = /does not exist in|exists on disk, but not in/

/** The file's content at the commit, or undefined when the path is absent there. */
const fileAt = ({ repo, commit, path }: { repo: string; commit: string; path: string }): string | undefined => {
  try {
    return git(repo, ["show", `${commit}:${path}`])
  } catch (error) {
    if (error instanceof GitError && PATH_ABSENT.test(error.stderr)) return undefined
    throw error
  }
}

const oldContent = ({ input, path, oldCommit }: ChangedFile): string | undefined => {
  return fileAt({ repo: input.repo, commit: oldCommit, path })
}

const newContent = ({ input, path }: ChangedFile): string | undefined => fileAt({ repo: input.repo, commit: input.to, path })

/** The commit holding a file's old content: the merge base in `pr` range, `from` itself in `tested` range. */
const resolveOldCommit = (input: GateInput): string => {
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

const sameJson = (before: unknown, after: unknown): boolean => {
  return JSON.stringify(sortKeys(before)) === JSON.stringify(sortKeys(after))
}

/** The object stored under the key, or an empty object when the value is missing or not an object. */
const readObjectField = (object: JsonObject, key: string): JsonObject => {
  const value = object[key]
  return isJsonObject(value) ? value : {}
}

const keysOfEither = (before: JsonObject, after: JsonObject): string[] => {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
}

/** The package an `npm:` alias spec installs; undefined for any other spec. */
const aliasTarget = (spec: unknown): string | undefined => {
  return typeof spec === "string" ? NPM_ALIAS.exec(spec)?.[1] : undefined
}

/** Returns why the dependency maps are not a plain version bump, or undefined when they are. */
const dependencyBumpProblem = (
  before: JsonObject,
  after: JsonObject,
  liveTestPackages: readonly string[],
): string | undefined => {
  for (const mapName of DEPENDENCY_MAPS) {
    const oldMap = readObjectField(before, mapName)
    const newMap = readObjectField(after, mapName)
    const oldKeys = Object.keys(oldMap).toSorted()
    const newKeys = Object.keys(newMap).toSorted()
    const packagesAddedOrRemoved = oldKeys.join("\n") !== newKeys.join("\n")

    // An override pins a package the tree already holds, so adding or removing one is still a version bump.
    if (mapName !== "overrides" && packagesAddedOrRemoved) return `${mapName} adds or removes a package`

    for (const name of keysOfEither(oldMap, newMap)) {
      // A nested override (an object) that did not change compares by value, not by reference.
      if (sameJson(oldMap[name], newMap[name])) continue
      // Both sides are checked: a move from `file:` to a range is a code change as much as the reverse.
      const specs = [oldMap[name], newMap[name]].filter((spec) => spec !== undefined)

      if (!specs.every(isString)) return `${mapName}.${name} is not a version string`
      // npm reads the tarball suffixes case-insensitively, so the spec is lowercased for the form check.
      if (!specs.every((spec) => REGISTRY_SPEC.test(spec.toLowerCase()))) return `${mapName}.${name} is not a registry version`
      // The live-test check reads the package each side installs: an alias's target, or else the key without
      // the version an overrides key may carry.
      const keyPackage = KEY_PACKAGE.exec(name)?.[1] ?? name
      const installedPackages = specs.map((spec) => aliasTarget(spec) ?? keyPackage)
      const livePackage = installedPackages.find((installed) => liveTestPackages.includes(installed))

      if (livePackage) return `${livePackage} is a live-test package`
      if (aliasTarget(oldMap[name]) !== aliasTarget(newMap[name])) return `${mapName}.${name} changes the package it installs`
    }
  }
  return undefined
}

/**
 * The scripts the image runs: the listed ones, the lifecycle scripts, their pre/post variants, and every
 * script those reach. A script is reached when its name appears as a word in a reached command, whatever
 * runs it (`npm run`, `npm test`, `npm-run-all`, `bun run`, a shell chain); a word that is also a script
 * name but means something else makes an extra artifact change, never a missed one. Both versions of the
 * scripts map are read, so a call the PR adds or removes still counts.
 */
const imageScriptNames = (scriptMaps: readonly JsonObject[], imageScripts: readonly string[]): Set<string> => {
  const roots = [...LIFECYCLE_SCRIPTS, ...imageScripts.flatMap((script) => [script, `pre${script}`, `post${script}`])]
  const names = new Set(roots)
  const scriptNames = new Set(scriptMaps.flatMap((scriptMap) => Object.keys(scriptMap)))

  // A Set's iterator also visits names added during the loop, so each newly reached script is scanned in
  // turn and the loop ends once no command reaches a new name.
  for (const name of names) {
    for (const scriptMap of scriptMaps) {
      const command = scriptMap[name]

      if (typeof command !== "string") continue
      for (const word of command.split(COMMAND_WORD_BREAK)) {
        if (!scriptNames.has(word)) continue
        // Running <name> runs pre<name> and post<name> too, and their commands can reach further scripts.
        for (const script of [word, `pre${word}`, `post${word}`]) names.add(script)
      }
    }
  }
  return names
}

const isImageScript = (scriptName: string, imageScripts: ReadonlySet<string>): boolean => {
  if (LIFECYCLE_SCRIPTS.includes(scriptName)) return true
  return [...imageScripts].some((script) => {
    return scriptName === script || scriptName === `pre${script}` || scriptName === `post${script}`
  })
}

const classifyPackageJson = (file: ChangedFile): Verdict => {
  const before = parseJson(oldContent(file))
  const after = parseJson(newContent(file))

  if (!before || !after) return { reason: "package.json unreadable at one side" }

  const restBefore = withoutKeys(before, DEPENDENCY_MAPS)
  const restAfter = withoutKeys(after, DEPENDENCY_MAPS)
  const sameOutsideDependencyMaps = sameJson(restBefore, restAfter)
  const sameOutsideScripts = sameJson(withoutKeys(restBefore, ["scripts"]), withoutKeys(restAfter, ["scripts"]))
  const sameDependencyMaps = DEPENDENCY_MAPS.every((mapName) => sameJson(before[mapName], after[mapName]))

  if (sameOutsideDependencyMaps) {
    const problem = dependencyBumpProblem(before, after, file.input.liveTestPackages)
    return problem ? { reason: problem } : "dependency"
  }
  if (!sameOutsideScripts) return { reason: "changes outside scripts and dependency maps" }
  if (!sameDependencyMaps) return { reason: "scripts and dependencies changed together" }

  const oldScripts = readObjectField(before, "scripts")
  const newScripts = readObjectField(after, "scripts")
  const imageScripts = imageScriptNames([oldScripts, newScripts], file.input.imageScripts)
  const changedScripts = keysOfEither(oldScripts, newScripts).filter((key) => oldScripts[key] !== newScripts[key])
  const imageScript = changedScripts.find((key) => isImageScript(key, imageScripts))
  return imageScript ? { reason: `scripts.${imageScript} runs during the image build` } : "scripts"
}

/** The lockfile is exempt unless a live-test package's entry changed. */
const classifyLockfile = (file: ChangedFile): Verdict => {
  const before = readObjectField(parseJson(oldContent(file)) ?? {}, "packages")
  const after = readObjectField(parseJson(newContent(file)) ?? {}, "packages")

  if (Object.keys(before).length === 0 || Object.keys(after).length === 0) {
    return { reason: "package-lock.json has no packages map at one side" }
  }

  const changedKeys = keysOfEither(before, after).filter((key) => !sameJson(before[key], after[key]))
  const entryName = (key: string): unknown => {
    const entry = after[key] ?? before[key]
    return isJsonObject(entry) ? entry.name : undefined
  }
  // npm keys each installed copy `node_modules/<name>`, nested under its parent's path when it is not
  // hoisted. An entry installed under another path (an alias or a link) carries the real package in its
  // `name` field.
  const installsPackage = (key: string, name: string): boolean => {
    return key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`) || entryName(key) === name
  }
  const livePackage = file.input.liveTestPackages.find((name) => changedKeys.some((key) => installsPackage(key, name)))
  return livePackage ? { reason: `${livePackage} is a live-test package` } : "dependency"
}

/** Whether a `-U0` hunk header removes as many lines as it adds; false for a header HUNK_HEADER cannot read. */
const hunkCountsMatch = (header: string): boolean => {
  const counts = HUNK_HEADER.exec(header)
  return counts !== null && (counts[1] ?? "1") === (counts[2] ?? "1")
}

/**
 * Removed and added lines of a `-U0` diff, paired in order; undefined when nothing changed or a hunk's
 * counts differ. Pairing across hunks would match a line removed in one place with one added in another,
 * so a moved FROM or `uses:` line would pass as a bump.
 */
const pairedLines = ({ input, path, oldCommit }: ChangedFile): LinePair[] | undefined => {
  const lines = git(input.repo, ["diff", "-U0", oldCommit, input.to, "--", path]).split("\n")
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"))
  const body = firstHunk === -1 ? [] : lines.slice(firstHunk).filter((line) => CHANGED_LINE.test(line))
  const removed = body.filter((line) => line.startsWith("-")).map((line) => line.slice(1))
  const added = body.filter((line) => line.startsWith("+")).map((line) => line.slice(1))
  const hunksPaired = lines.filter((line) => line.startsWith("@@")).every(hunkCountsMatch)

  if (!hunksPaired || removed.length !== added.length || removed.length === 0) return undefined
  return removed.flatMap((line, index) => {
    const partner = added[index]
    // The counts are equal, so every removed line has a partner; this check only narrows the type.
    return partner === undefined ? [] : [{ removed: line, added: partner }]
  })
}

// A Dockerfile or workflow change that is not a paired digest or action bump may still be comment-only,
// which the orchestrator judges from the hunk. Only reasons that leave that possibility open carry this
// suffix: a changed FROM or `uses:` line is never a comment.
const JUDGE_THE_HUNK = "judge the hunk, deploy when unsure"

const classifyDockerfile = (file: ChangedFile): Verdict => {
  const pairs = pairedLines(file)

  if (!pairs) return { reason: `lines added or removed, not paired; ${JUDGE_THE_HUNK}` }
  for (const { removed, added } of pairs) {
    if (!FROM_LINE.test(removed) || !FROM_LINE.test(added)) {
      return { reason: `a changed line is not a FROM line; ${JUDGE_THE_HUNK}` }
    }
    if (!DIGEST.test(removed) || !DIGEST.test(added)) return { reason: "a FROM line has no digest" }
    if (removed.replace(DIGEST, "") !== added.replace(DIGEST, "")) {
      return { reason: "a FROM line changes more than its digest" }
    }
  }
  return "digest"
}

const classifyWorkflow = (file: ChangedFile): Verdict => {
  const pairs = pairedLines(file)

  if (!pairs) return { reason: `lines added or removed, not paired; ${JUDGE_THE_HUNK}` }
  for (const { removed, added } of pairs) {
    const before = USES_LINE.exec(removed)
    const after = USES_LINE.exec(added)

    if (!before || !after) return { reason: `a changed line is not a uses: line; ${JUDGE_THE_HUNK}` }
    if (before[1] !== after[1]) return { reason: `the action changes from ${before[1]} to ${after[1]}` }
    // With the same action and version, the pair differs elsewhere on the line, or the line only moved;
    // neither is a version bump.
    if (before[2] === after[2]) return { reason: "a uses: line changes outside its version" }
  }
  return "action"
}

// Every option that drops or rewrites code stays off: two sources that differ only in code it removed
// would compare equal, and a real change would pass as comment-only.
// - `macro: false` stops the transpiler running a `with { type: "macro" }` import while it reads the PR's
//   text; such an import can run any command on the reviewer's machine.
// - `define` maps each value the transpiler substitutes by default to itself, so a PR that swaps
//   `process.env.NODE_ENV` for the literal `"development"` is still a code change.
const TRANSPILE_OPTIONS = {
  deadCodeElimination: false,
  treeShaking: false,
  trimUnusedImports: false,
  minifyWhitespace: false,
  inline: false,
  macro: false,
  define: {
    "process.env.NODE_ENV": "process.env.NODE_ENV",
    "process.env.BUN_ENV": "process.env.BUN_ENV",
    "process.browser": "process.browser",
  },
} as const

// The transpiler drops a leading `#!` line and every "use strict" directive, though either changes how the
// file runs, so classifyCode compares them itself. A directive is a line holding only the string; a
// directive that moves between a file's prologue and a function body keeps the same list, which the
// comparison accepts.
const HASHBANG = /^#!.*/
const USE_STRICT_LINE = /^\s*(["'])use strict\1\s*;?\s*$/gm
const USE_STRICT = /(["'])use strict\1/g
// A macro import attribute in any of its spellings (`with`/`assert`, quoted or bare key), which the
// transpiler would otherwise run; the text is refused before it is parsed, so `macro: false` is not the only
// guard.
const MACRO_IMPORT = /(["']?)type\1\s*:\s*(["'])macro\2/

/**
 * The file as the transpiler prints it, or undefined when it cannot parse the text or the text imports a
 * macro. The output drops comments, and it also drops TypeScript types and the source's formatting, so a
 * type-only or reformat-only edit prints the same text too.
 */
const stripComments = (text: string, loader: Loader): string | undefined => {
  try {
    return new Bun.Transpiler({ loader, ...TRANSPILE_OPTIONS }).transformSync(text)
  } catch {
    return undefined
  }
}

const classifyCode = (file: ChangedFile, loader: Loader): Verdict => {
  const before = oldContent(file)
  const after = newContent(file)
  // An empty file is valid content, so the check is for a missing file, not a falsy one.
  if (before === undefined || after === undefined) return { reason: "file unreadable at one side" }

  if (MACRO_IMPORT.test(before) || MACRO_IMPORT.test(after)) return { reason: "the file imports a macro, which the gate never runs" }
  const sameHashbang = HASHBANG.exec(before)?.[0] === HASHBANG.exec(after)?.[0]
  const sameDirectives = (before.match(USE_STRICT_LINE) ?? []).join("\n") === (after.match(USE_STRICT_LINE) ?? []).join("\n")
  // A directive that shares its line with code escapes the line match, so the literal's count is compared too.
  const sameDirectiveCount = (before.match(USE_STRICT) ?? []).length === (after.match(USE_STRICT) ?? []).length

  if (!sameHashbang || !sameDirectives || !sameDirectiveCount) return { reason: "code changed beyond comments" }

  const strippedBefore = stripComments(before, loader)
  const strippedAfter = stripComments(after, loader)

  if (strippedBefore === undefined || strippedAfter === undefined) {
    return { reason: "the transpiler could not parse the file" }
  }
  return strippedBefore === strippedAfter ? "comment" : { reason: "code changed beyond comments" }
}

const classifyByFileType = (file: ChangedFile): Verdict => {
  const name = basename(file.path)
  const loader = LOADERS[extname(name)]

  if (name === "package.json") return classifyPackageJson(file)
  if (name === "package-lock.json") return classifyLockfile(file)
  if (name.startsWith("Dockerfile")) return classifyDockerfile(file)
  if (file.path.startsWith(".github/workflows/")) return classifyWorkflow(file)
  if (loader) return classifyCode(file, loader)
  return { reason: `no deterministic class for this file type; ${JUDGE_THE_HUNK}` }
}

const classifyFile = (file: ChangedFile): FileVerdict => {
  const { input, path } = file
  const verdict = classifyByFileType(file)

  if (typeof verdict !== "string") return { path, exemptAs: undefined, reason: verdict.reason }
  if (!input.exempt.includes(verdict)) {
    return { path, exemptAs: undefined, reason: `${verdict} is not a selected exemption` }
  }
  return { path, exemptAs: verdict, reason: verdict }
}

export const classify = (input: GateInput): GateResult => {
  // One old commit serves the file list and every file read, so the two cannot disagree.
  const oldCommit = resolveOldCommit(input)
  const artifactFiles = changedFiles(input, oldCommit, input.pathspecs)
  // Audit-path files count when no artifact file needs the live test: an unexempt artifact change already
  // deploys, and the deploy covers them.
  const auditFiles = changedFiles(input, oldCommit, input.auditPathspecs)
    .filter((path) => !artifactFiles.includes(path))
    .map((path) => ({ path, exemptAs: undefined, reason: "audit path" }))

  if (artifactFiles.length === 0 && auditFiles.length === 0) return { outcome: "no artifact change", summary: "no artifact change", files: [] }

  const files = artifactFiles.map((path) => classifyFile({ input, path, oldCommit }))
  const unexemptFiles = files.filter((file) => !file.exemptAs)

  if (unexemptFiles.length === 0 && auditFiles.length > 0) {
    return { outcome: "local change", summary: `local change (${auditFiles.length} files)`, files: [...files, ...auditFiles] }
  }

  if (unexemptFiles.length > 0) {
    const paths = unexemptFiles.map((file) => file.path).join(", ")
    return { outcome: "artifact change", summary: `artifact change (${unexemptFiles.length} files: ${paths})`, files }
  }

  const classes = [...new Set(files.flatMap((file) => (file.exemptAs ? [file.exemptAs] : [])))].toSorted()
  return { outcome: "exempt", summary: `exempt (${classes.join(", ")})`, files }
}

const toExemptClass = (name: string): ExemptClass => {
  if (!isExemptClass(name)) throw new Error(`unknown exemption class: ${name}`)
  return name
}

const parseExempt = (values: readonly string[]): ExemptClass[] => {
  const names = values.flatMap((value) => value.split(",")).map((value) => value.trim())
  return names.filter((name) => name.length > 0).map(toExemptClass)
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
  if (values.from.startsWith("-") || values.to.startsWith("-")) {
    throw new Error("--from and --to must name commits, not options")
  }
  // With no paths at all the answer would be a confident `no artifact change`. A profile that lacks its
  // `Artifact paths:` and `Audit paths:` lines must get an error instead.
  if (values.pathspec.length === 0 && values["audit-pathspec"].length === 0) {
    throw new Error("at least one --pathspec or --audit-pathspec is required")
  }

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
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.summary}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(error instanceof GitError ? 2 : 1)
  }
}
