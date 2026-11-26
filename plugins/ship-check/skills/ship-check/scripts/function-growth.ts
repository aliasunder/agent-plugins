#!/usr/bin/env bun
// Measures how the cyclomatic complexity of each function changed between two commits, with the reviewed
// repo's own ESLint `complexity` rule, for the ship-check design pass's `Growth:` line. The text it prints
// is what the reports print after that label; `--json` prints the full result. ESLint and the TypeScript
// parser load from `--tooling` (default: the repo); without ESLint there the answer is `not measured`.
// Exit codes: 0 measured or not measured, 2 git failure, 1 any other error.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, extname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

/** A position in ESTree form: `line` counts from 1, `column` from 0. */
export type Position = { line: number; column: number }

/** What a function's name is read from, found in the syntax tree around the function node. */
export type NameSource =
  | { kind: "name"; name: string }
  | { kind: "key"; key: string; owner: string | null }
  | { kind: "assignment"; target: string }
  | { kind: "default" }
  | { kind: "iife" }
  | { kind: "callback"; callee: string | null }
  | { kind: "static-block"; owner: string | null }

/**
 * A node the complexity rule reports on, in source order:
 * - `function`: a function declaration, function expression or arrow function
 * - `field`: a class field with an initializer, which the rule measures as its own code path
 * - `static-block`: a class static block
 * `enclosing` is the index of the innermost function span around this one.
 */
export type FunctionSpan = {
  kind: "function" | "field" | "static-block"
  start: Position
  end: Position
  source: NameSource
  enclosing: number | null
}

/** The fields of an ESLint message this script reads; `line` and `column` count from 1. */
export type LintMessage = {
  ruleId: string | null
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  fatal?: boolean
}

export type NamedSpan = { span: FunctionSpan; name: string; enclosingName: string | null }

export type MeasuredFunction = { name: string; enclosing: string | null; line: number; complexity: number }

export type FunctionPair = { base: MeasuredFunction; head: MeasuredFunction; pairedBy: "name" | "enclosing" }

export type PairedFunctions = { pairs: FunctionPair[]; added: MeasuredFunction[] }

/**
 * The complexity a function may reach under the file's configuration, and the rule's own `variant` option:
 * - `default`: the rule is off or absent, so the script lists growth against ESLint's default maximum
 * - `warned`: the rule is on at severity 1
 * - `enforced`: the rule is on at severity 2
 */
export type Budget = { max: number; source: "default" | "warned" | "enforced"; variant: "classic" | "modified" }

/** A changed file the head still has; `basePath` is null for a file added since the base. */
export type ChangedFile = { path: string; basePath: string | null }

/**
 * A function in the JSON output. `base` is null and `pairedBy` null for a function new at the head;
 * `basePath` is the file's path at the base commit, which differs from `path` for a renamed file.
 */
export type GrowthEntry = {
  path: string
  basePath: string | null
  name: string
  headLine: number
  base: number | null
  head: number
  budget: number
  budgetSource: Budget["source"]
  pairedBy: FunctionPair["pairedBy"] | null
}

export type NotMeasured = { path: string; reason: string }

/** What `formatLine` prints from; the counts and lists mean what they mean in `GrowthReport`. */
export type LineInput =
  | { status: "no eslint"; tooling: string }
  | {
      status: "measured"
      measured: number
      rose: number
      measuredFiles: number
      /** The distinct `<max> (<source>)` labels of the measured files. */
      budgets: readonly string[]
      listed: readonly GrowthEntry[]
      notMeasured: readonly NotMeasured[]
    }

/**
 * The script's result; `--json` prints it whole:
 * - `measured`: how many functions were measured at the head, new ones included
 * - `rose`: how many functions paired with a base function have a higher complexity at the head
 * - `functions`: every function paired with a base function; a new function is left out of it
 * - `listed`: the functions past their file's budget at the head that rose or are new, sorted by path and line
 * - `notMeasured`: each file the script could not measure, with the reason
 */
export type GrowthReport = {
  line: string
  measured: number
  rose: number
  functions: GrowthEntry[]
  listed: GrowthEntry[]
  notMeasured: NotMeasured[]
}

export class GitError extends Error {
  readonly stderr: string

  constructor(message: string, stderr: string) {
    super(message)
    this.stderr = stderr
  }
}

const TYPESCRIPT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"]
const MEASURED_EXTENSIONS: readonly string[] = [...TYPESCRIPT_EXTENSIONS, ".js", ".jsx", ".mjs", ".cjs"]
const MEASURED_GLOB = `**/*.{${MEASURED_EXTENSIONS.map((extension) => extension.slice(1)).join(",")}}`
const JSX_GLOB = "**/*.{tsx,jsx}"
// Test files are left out, as the design pass leaves them out of its read: the test-audit phase owns them.
const TEST_FOLDER = /(^|\/)__tests__\//
const TEST_FILE = /\.(test|spec)\./
// ESLint's own maximum when the rule is on without one, and the budget for a file where the rule is off.
const ESLINT_DEFAULT_MAX = 20
const DEFAULT_BUDGET: Budget = { max: ESLINT_DEFAULT_MAX, source: "default", variant: "classic" }
// The report line names this many functions; the JSON carries every listed one.
const MAX_LINE_NAMES = 8
// The complexity rule's message: group 1 names what was measured, group 2 is the number.
const COMPLEXITY_MESSAGE = /^(.*) has a complexity of (\d+)\./
const FUNCTION_TYPES: readonly string[] = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]
const CLASS_TYPES: readonly string[] = ["ClassDeclaration", "ClassExpression"]
const KEYED_MEMBER_TYPES: readonly string[] = ["Property", "MethodDefinition", "PropertyDefinition"]
// Joins an anonymous function's name to the name of the function around it; `namedAfterEnclosing` reads it back.
const ENCLOSING_SEPARATOR = " › "
// Keys that point back up or across the tree, or hold position data, never at a child node.
const NON_CHILD_KEYS: readonly string[] = ["parent", "loc", "range", "tokens", "comments"]
const WHITESPACE = /\s+/g
// By default execFileSync fails once a child's output passes 1 MiB, and a generated file can run larger.
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024

type JsonObject = Record<string, unknown>
type AstNode = JsonObject & { type: string; range: [number, number]; loc: { start: Position; end: Position } }
export type LintFile = { messages: LintMessage[]; tree: { ast: AstNode; text: string } | undefined }
export type Linter = (code: string, filePath: string) => Promise<LintFile>
type EslintInstance = {
  lintText: (code: string, options: { filePath: string }) => Promise<unknown>
  calculateConfigForFile: (filePath: string) => Promise<unknown>
}
type EslintConstructor = new (options: JsonObject) => EslintInstance
export type Tooling = { ESLint: EslintConstructor; parser: unknown }
type RunOptions = { repo: string; from: string; to: string; tooling: string }
export type FileMeasurement = { path: string; basePath: string | null; budget: Budget; head: MeasuredFunction[]; paired: PairedFunctions }
type MeasureContext = Omit<RunOptions, "tooling"> & { tooling: Tooling; linters: Map<Budget["variant"], Linter>; repoConfigEslint: EslintInstance }

const isJsonObject = (value: unknown): value is JsonObject => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const isPosition = (value: unknown): value is Position => {
  return isJsonObject(value) && typeof value.line === "number" && typeof value.column === "number"
}

const isAstNode = (value: unknown): value is AstNode => {
  if (!isJsonObject(value) || typeof value.type !== "string" || !Array.isArray(value.range)) return false
  return isJsonObject(value.loc) && isPosition(value.loc.start) && isPosition(value.loc.end)
}

const isEslintConstructor = (value: unknown): value is EslintConstructor => typeof value === "function"

const isLintMessage = (value: unknown): value is LintMessage => {
  return isJsonObject(value) && typeof value.message === "string" && typeof value.line === "number" && typeof value.column === "number"
}

const childNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key]
  return isAstNode(value) ? value : undefined
}

const childNodes = (node: AstNode): AstNode[] => {
  return Object.entries(node)
    .filter(([key]) => !NON_CHILD_KEYS.includes(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(isAstNode)
}

const git = (repo: string, args: readonly string[]): string => {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    })
  } catch (error) {
    const stderr = isJsonObject(error) && typeof error.stderr === "string" ? error.stderr : ""
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`, stderr)
  }
}

const isMeasuredPath = (path: string): boolean => {
  return MEASURED_EXTENSIONS.includes(extname(path)) && !TEST_FOLDER.test(path) && !TEST_FILE.test(basename(path))
}

/**
 * The measured files in `git diff --name-status -M -z` output: each entry is a status, then one path, or
 * the old and the new path for a rename or copy. A renamed file's base copy is read from its old path.
 */
export const selectFiles = (nameStatus: string): ChangedFile[] => {
  // `-z` ends every field with a NUL, so the split leaves one empty field after the last.
  const fields = nameStatus.split("\0").slice(0, -1)
  const files: ChangedFile[] = []
  // Each pass moves the read position past one entry's status and its one or two paths.
  let index = 0

  while (index < fields.length) {
    const status = fields[index]
    const pathCount = status?.startsWith("R") || status?.startsWith("C") ? 2 : 1
    const paths = fields.slice(index + 1, index + 1 + pathCount)
    const [oldPath] = paths
    const path = paths.at(-1)
    index += 1 + pathCount

    if (!status || !oldPath || !path || paths.length < pathCount) throw new Error(`unexpected git diff output: ${JSON.stringify(nameStatus)}`)
    if (!isMeasuredPath(path)) continue
    files.push({ path, basePath: status.startsWith("A") ? null : oldPath })
  }
  return files
}

// Base and head functions pair by name, so a name read from source drops its whitespace and survives a reformat.
const sourceOf = (text: string, node: AstNode): string => text.slice(node.range[0], node.range[1]).replace(WHITESPACE, "")

/** A binding's name; a TypeScript identifier's range takes in its type annotation, so it is read from `name`. */
const bindingName = (text: string, node: AstNode): string => {
  return node.type === "Identifier" && typeof node.name === "string" ? node.name : sourceOf(text, node)
}

const isFunctionNode = (node: AstNode): boolean => FUNCTION_TYPES.includes(node.type)

/**
 * Whether the variable the parent initializes also names the child:
 * - `await`, `as`, a conditional branch or a logical operand hands the child's value on as the parent's
 * - a call or `new` that takes the child as an argument names the callback after the variable its result lands in
 */
const wrapsValue = (parent: AstNode, child: AstNode): boolean => {
  switch (parent.type) {
    case "CallExpression":
    case "NewExpression":
      return Array.isArray(parent.arguments) && parent.arguments.includes(child)
    case "AwaitExpression":
    case "TSAsExpression":
      return true
    case "ConditionalExpression":
      return parent.consequent === child || parent.alternate === child
    case "LogicalExpression":
      return parent.left === child || parent.right === child
    default:
      return false
  }
}

/**
 * The variable whose initializer holds the node, climbing one wrapper wrapsValue accepts per call:
 * `const x = await call(() => …)` gives `x` for the arrow.
 */
const initializedVariable = (text: string, node: AstNode, ancestors: readonly AstNode[]): string | undefined => {
  const parent = ancestors.at(-1)
  if (!parent) return undefined

  if (parent.type === "VariableDeclarator") {
    const id = childNode(parent, "id")
    return parent.init === node && id ? bindingName(text, id) : undefined
  }
  if (!wrapsValue(parent, node)) return undefined
  return initializedVariable(text, parent, ancestors.slice(0, -1))
}

const isNamedClass = (node: AstNode): boolean => CLASS_TYPES.includes(node.type) && Boolean(childNode(node, "id"))

/** The class or variable a member belongs to: the nearest named class, or the variable a class or object sits in. */
const ownerName = (text: string, ancestors: readonly AstNode[]): string | null => {
  const owner = ancestors.findLast((ancestor) => isNamedClass(ancestor) || ancestor.type === "VariableDeclarator")
  const ownerId = owner ? childNode(owner, "id") : undefined
  return ownerId ? bindingName(text, ownerId) : null
}

/** The callee's last member name: `withExclusiveFileLock` for `withExclusiveFileLock(…)`, `map` for `items.map(…)`. */
const calleeName = (text: string, call: AstNode): string | null => {
  const callee = childNode(call, "callee")
  if (!callee) return null

  const property = callee.type === "MemberExpression" ? childNode(callee, "property") : undefined
  return sourceOf(text, property ?? callee)
}

const isCallLike = (node: AstNode): boolean => node.type === "CallExpression" || node.type === "NewExpression"

/**
 * The first source that fits, checked in order. A function that fits none (an argument, an array element, a
 * returned function) is a callback, which carries a callee only when the function is a call's argument.
 */
const functionNameSource = (text: string, node: AstNode, ancestors: readonly AstNode[]): NameSource => {
  const id = childNode(node, "id")
  if (id) return { kind: "name", name: bindingName(text, id) }

  const variable = initializedVariable(text, node, ancestors)
  if (variable) return { kind: "name", name: variable }

  const parent = ancestors.at(-1)
  const key = parent ? childNode(parent, "key") : undefined
  if (parent && key && KEYED_MEMBER_TYPES.includes(parent.type)) {
    return { kind: "key", key: sourceOf(text, key), owner: ownerName(text, ancestors.slice(0, -1)) }
  }

  const left = parent?.type === "AssignmentExpression" ? childNode(parent, "left") : undefined
  if (left) return { kind: "assignment", target: sourceOf(text, left) }
  if (parent?.type === "ExportDefaultDeclaration") return { kind: "default" }
  if (parent && isCallLike(parent) && parent.callee === node) return { kind: "iife" }
  return { kind: "callback", callee: parent && isCallLike(parent) ? calleeName(text, parent) : null }
}

type Visited = { node: AstNode; ancestors: readonly AstNode[] }

const spanKind = (node: AstNode): FunctionSpan["kind"] | undefined => {
  if (isFunctionNode(node)) return "function"
  if (node.type === "PropertyDefinition" && childNode(node, "value")) return "field"
  if (node.type === "StaticBlock") return "static-block"
  return undefined
}

const spanSource = (text: string, { node, ancestors }: Visited, kind: FunctionSpan["kind"]): NameSource => {
  if (kind === "function") return functionNameSource(text, node, ancestors)
  if (kind === "static-block") return { kind: "static-block", owner: ownerName(text, ancestors) }

  const key = childNode(node, "key")
  return { kind: "key", key: key ? sourceOf(text, key) : "", owner: ownerName(text, ancestors) }
}

const collectNodes = (ast: AstNode): Visited[] => {
  const visited: Visited[] = []
  const visit = (node: AstNode, ancestors: readonly AstNode[]): void => {
    visited.push({ node, ancestors })
    for (const child of childNodes(node)) visit(child, [...ancestors, node])
  }
  visit(ast, [])
  return visited
}

/** Every function, class field initializer and static block in the tree, in source order, with its name source. */
export const extractFunctionSpans = (ast: unknown, text: string): FunctionSpan[] => {
  if (!isAstNode(ast)) throw new Error("the parser returned no syntax tree")

  // The walk follows each node's key order, which need not be source order, so the spans are sorted by start.
  // A parent starts no later than its child, and the depth breaks a tie, so an enclosing span always comes first.
  const visited = collectNodes(ast)
    .flatMap((entry) => {
      const kind = spanKind(entry.node)
      return kind ? [{ ...entry, kind }] : []
    })
    .toSorted((first, second) => first.node.range[0] - second.node.range[0] || first.ancestors.length - second.ancestors.length)
  const indexOfNode = new Map(visited.map(({ node }, index) => [node, index]))

  return visited.map((entry) => {
    const enclosingNode = entry.ancestors.findLast(isFunctionNode)
    const enclosing = enclosingNode ? (indexOfNode.get(enclosingNode) ?? null) : null
    return { kind: entry.kind, start: entry.node.loc.start, end: entry.node.loc.end, source: spanSource(text, entry, entry.kind), enclosing }
  })
}

/** A span's name before duplicates are numbered; `enclosingName` is the name of the function around it. */
export const nameFunction = (span: FunctionSpan, enclosingName: string | null): string => {
  const { source } = span
  switch (source.kind) {
    case "name":
      return source.name
    case "key": {
      const qualified = source.owner ? `${source.owner}.${source.key}` : source.key
      return span.kind === "field" ? `${qualified} initializer` : qualified
    }
    case "assignment":
      return source.target
    case "default":
      return "default"
    case "static-block":
      return source.owner ? `${source.owner} static block` : "static block"
    case "iife":
      return enclosingName ? `${enclosingName}${ENCLOSING_SEPARATOR}IIFE` : "IIFE"
    case "callback": {
      if (!enclosingName) return "<anonymous>"
      const callback = `${enclosingName}${ENCLOSING_SEPARATOR}callback`
      return source.callee ? `${callback} (${source.callee})` : callback
    }
  }
}

/** Every span with its name, numbered ` #2`, ` #3` on repeats in source order, and its enclosing function's name. */
export const nameFunctions = (spans: readonly FunctionSpan[]): NamedSpan[] => {
  const named: NamedSpan[] = []
  const seen = new Map<string, number>()

  for (const span of spans) {
    const enclosingName = span.enclosing === null ? null : (named[span.enclosing]?.name ?? null)
    const name = nameFunction(span, enclosingName)
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    named.push({ span, name: count === 1 ? name : `${name} #${count}`, enclosingName })
  }
  return named
}

/** ESLint's complexity message calls a field `Class field initializer`, a static block `Class static block`. */
const reportedKind = (subject: string | undefined): FunctionSpan["kind"] => {
  if (subject === "Class field initializer") return "field"
  if (subject === "Class static block") return "static-block"
  return "function"
}

const atOrBefore = (first: Position, second: Position): boolean => {
  return first.line < second.line || (first.line === second.line && first.column <= second.column)
}

/**
 * Each complexity message as a named function. A message belongs to the innermost span of its kind that
 * contains the message's end position, the span's own start included: the rule reports a function's head,
 * which for a method starts at the key, before the function node.
 */
export const measureFunctions = (messages: readonly LintMessage[], spans: readonly FunctionSpan[]): MeasuredFunction[] => {
  const named = nameFunctions(spans)

  return messages.flatMap((message) => {
    const match = message.ruleId === "complexity" ? COMPLEXITY_MESSAGE.exec(message.message) : null
    if (!match) return []

    const [, subject, complexity] = match
    const kind = reportedKind(subject)
    // ESLint columns count from 1 and ESTree columns from 0.
    const end = { line: message.endLine ?? message.line, column: (message.endColumn ?? message.column) - 1 }
    // In the order `extractFunctionSpans` gives, the last span that contains the position is the innermost.
    const owner = named.findLast(({ span }) => span.kind === kind && atOrBefore(span.start, end) && atOrBefore(end, span.end))
    const name = owner ? owner.name : `<unresolved at line ${message.line}>`
    return [{ name, enclosing: owner ? owner.enclosingName : null, line: message.line, complexity: Number(complexity) }]
  })
}

/** A callback or IIFE is named after its enclosing function (`nameFunction`), so only those may pair by enclosing. */
const namedAfterEnclosing = (measured: MeasuredFunction): boolean => {
  return measured.enclosing !== null && measured.name.startsWith(`${measured.enclosing}${ENCLOSING_SEPARATOR}`)
}

// The ` #2`, ` #3` suffix `nameFunctions` adds counts from the file's start, so same-named functions are paired as a group.
const DUPLICATE_SUFFIX = /\s#\d+$/

const groupName = (measured: MeasuredFunction): string => measured.name.replace(DUPLICATE_SUFFIX, "")

const groupByName = (functions: readonly MeasuredFunction[]): Map<string, MeasuredFunction[]> => Map.groupBy(functions, groupName)

/**
 * Pairs the base and head functions that share one name. With equal counts the order pairs them. With
 * different counts a sibling was inserted or removed, which renumbers every later suffix, so an equal
 * complexity marks the same function first and the rest pair in order.
 */
const pairSameNamed = (baseGroup: readonly MeasuredFunction[], headGroup: readonly MeasuredFunction[]): Map<MeasuredFunction, MeasuredFunction> => {
  // A working pool the pairs claim from, so each base function pairs once.
  const remainingBase = [...baseGroup]
  const baseForHead = new Map<MeasuredFunction, MeasuredFunction>()
  const claim = (headFunction: MeasuredFunction, baseFunction: MeasuredFunction): void => {
    remainingBase.splice(remainingBase.indexOf(baseFunction), 1)
    baseForHead.set(headFunction, baseFunction)
  }

  if (baseGroup.length !== headGroup.length) {
    for (const headFunction of headGroup) {
      const sameComplexity = remainingBase.find((baseFunction) => baseFunction.complexity === headFunction.complexity)
      if (sameComplexity) claim(headFunction, sameComplexity)
    }
  }
  for (const headFunction of headGroup) {
    const [nextBase] = remainingBase
    if (!baseForHead.has(headFunction) && nextBase) claim(headFunction, nextBase)
  }
  return baseForHead
}

/**
 * Pairs base and head functions by name. An anonymous head function (a callback or IIFE) with no partner
 * pairs with an anonymous base function that disappeared under the same enclosing function, such as a
 * callback whose wrapper changed; a named function pairs by name only. Anything else is new.
 */
export const pairFunctions = (base: readonly MeasuredFunction[], head: readonly MeasuredFunction[]): PairedFunctions => {
  const baseGroups = groupByName(base)
  const baseForHead = new Map<MeasuredFunction, MeasuredFunction>()
  for (const [name, headGroup] of groupByName(head)) {
    for (const [headFunction, baseFunction] of pairSameNamed(baseGroups.get(name) ?? [], headGroup)) baseForHead.set(headFunction, baseFunction)
  }
  const pairedBase = new Set(baseForHead.values())
  const disappeared = base.filter((measured) => !pairedBase.has(measured))
  const claimed = new Set<MeasuredFunction>()
  const pairs: FunctionPair[] = []
  const added: MeasuredFunction[] = []

  for (const headFunction of head) {
    const byName = baseForHead.get(headFunction)
    if (byName) {
      pairs.push({ base: byName, head: headFunction, pairedBy: "name" })
      continue
    }

    const { enclosing } = headFunction
    const partner = namedAfterEnclosing(headFunction)
      ? disappeared.find((candidate) => !claimed.has(candidate) && candidate.enclosing === enclosing && namedAfterEnclosing(candidate))
      : undefined
    if (!partner) {
      added.push(headFunction)
      continue
    }
    claimed.add(partner)
    pairs.push({ base: partner, head: headFunction, pairedBy: "enclosing" })
  }
  return { pairs, added }
}

const severityOf = (value: unknown): number => {
  if (typeof value === "number") return value
  if (value === "warn") return 1
  if (value === "error") return 2
  return 0
}

const maxOf = (options: unknown): number => {
  if (typeof options === "number") return options
  if (!isJsonObject(options)) return ESLINT_DEFAULT_MAX
  if (typeof options.max === "number") return options.max
  // `maximum` is the rule's second name for `max`; its schema accepts both.
  return typeof options.maximum === "number" ? options.maximum : ESLINT_DEFAULT_MAX
}

/** The budget from a resolved `complexity` rule entry: a severity alone, or `[severity, options]`. */
export const parseBudget = (rule: unknown): Budget => {
  const [severityValue, options]: unknown[] = Array.isArray(rule) ? rule : [rule]
  const severity = severityOf(severityValue)
  if (severity !== 1 && severity !== 2) return DEFAULT_BUDGET

  const variant = isJsonObject(options) && options.variant === "modified" ? "modified" : "classic"
  return { max: maxOf(options), source: severity === 1 ? "warned" : "enforced", variant }
}

const budgetLabel = (budget: Budget): string => `${budget.max} (${budget.source})`

const entryText = (entry: GrowthEntry): string => `${entry.path} ${entry.name} ${entry.base ?? "new"} → ${entry.head}`

const listedText = (listed: readonly GrowthEntry[]): string => {
  const names = listed.slice(0, MAX_LINE_NAMES).map(entryText)
  const hidden = listed.length - names.length
  return hidden > 0 ? `${names.join(", ")}, +${hidden} more` : names.join(", ")
}

/** The line gives the first file's reason only; the JSON's `notMeasured` carries each file's path and reason. */
const notMeasuredText = (notMeasured: readonly NotMeasured[]): string => {
  const [first] = notMeasured
  if (!first) return ""

  const files = notMeasured.length === 1 ? "1 file" : `${notMeasured.length} files`
  return `; not measured: ${files} (${first.reason})`
}

/** The text the reports print after `Growth:`. */
export const formatLine = (input: LineInput): string => {
  if (input.status === "no eslint") return `not measured (no ESLint in ${input.tooling})`

  const suffix = notMeasuredText(input.notMeasured)
  if (input.measuredFiles === 0) return `no measurable files${suffix}`

  const budgets = input.budgets.join(" / ")
  const past = input.listed.length === 0 ? `none past budget ${budgets}` : `${input.listed.length} past budget ${budgets}: ${listedText(input.listed)}`
  return `${input.rose} of ${input.measured} measured functions rose; ${past}${suffix}`
}

const readMessages = (results: unknown): LintMessage[] => {
  const [first] = Array.isArray(results) ? results : []
  const messages = isJsonObject(first) && Array.isArray(first.messages) ? first.messages : []
  return messages.filter(isLintMessage)
}

/**
 * A linter that measures every function, separate from the repo's own config, which `run` reads only for budgets:
 * - `overrideConfigFile: true` loads none of the repo's config, so only `complexity` and the capture rule run
 * - `allowInlineConfig: false` ignores disable directives, so a directive cannot hide a function
 * - `max: 0` puts every function over the limit, so the rule reports each one with its complexity
 */
export const createLinter = (tooling: Tooling, repo: string, variant: Budget["variant"]): Linter => {
  // The capture rule hands back the tree ESLint parsed, so the names come from the same parse as the numbers.
  const capturedTrees: { ast: AstNode; text: string }[] = []
  const capture = {
    meta: { schema: [] },
    create: (context: unknown) => ({
      Program: (node: unknown) => {
        const sourceCode = isJsonObject(context) ? context.sourceCode : undefined
        const text = isJsonObject(sourceCode) ? sourceCode.text : undefined
        if (isAstNode(node) && typeof text === "string") capturedTrees.push({ ast: node, text })
      },
    }),
  }
  const languageOptions = tooling.parser ? { parser: tooling.parser } : {}
  const instance = new tooling.ESLint({
    cwd: repo,
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [
      {
        files: [MEASURED_GLOB],
        languageOptions,
        plugins: { "function-growth": { rules: { capture } } },
        rules: { complexity: ["warn", { max: 0, variant }], "function-growth/capture": "warn" },
      },
      { files: [JSX_GLOB], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
    ],
  })

  return async (code, filePath) => {
    capturedTrees.length = 0
    const messages = readMessages(await instance.lintText(code, { filePath }))
    return { messages, tree: capturedTrees.at(-1) }
  }
}

/** The linter for a variant, built once per run: each linter's rule options fix its variant. */
const linterFor = (context: MeasureContext, variant: Budget["variant"]): Linter => {
  const existing = context.linters.get(variant)
  if (existing) return existing

  const linter = createLinter(context.tooling, context.repo, variant)
  context.linters.set(variant, linter)
  return linter
}

/** The file's functions, or the reason it cannot be measured: a fatal message or an ignored file. */
const measureCopy = async (linter: Linter, code: string, filePath: string): Promise<MeasuredFunction[] | string> => {
  const { messages, tree } = await linter(code, filePath)
  // ESLint reports an ignored file, such as one under `node_modules`, with a warning that starts `File ignored`.
  const failure = messages.find((message) => message.fatal || message.message.startsWith("File ignored"))
  if (failure) return failure.message
  if (!tree) return "ESLint returned no syntax tree"

  return measureFunctions(messages, extractFunctionSpans(tree.ast, tree.text))
}

/** The `complexity` entry the repo's own config resolves for the path; the file need not exist on disk. */
const budgetRule = async (repoConfigEslint: EslintInstance, filePath: string): Promise<unknown> => {
  const config = await repoConfigEslint.calculateConfigForFile(filePath)
  const rules = isJsonObject(config) ? config.rules : undefined
  return isJsonObject(rules) ? rules.complexity : undefined
}

const measureFile = async (context: MeasureContext, file: ChangedFile): Promise<FileMeasurement | NotMeasured> => {
  const { path, basePath } = file
  if (!context.tooling.parser && TYPESCRIPT_EXTENSIONS.includes(extname(path))) return { path, reason: "no TypeScript parser" }

  const filePath = join(context.repo, path)
  const budget = parseBudget(await budgetRule(context.repoConfigEslint, filePath))
  const linter = linterFor(context, budget.variant)
  // Both copies lint under the head path, so a rename that changes the extension still reads both with one config.
  const head = await measureCopy(linter, git(context.repo, ["show", `${context.to}:${path}`]), filePath)
  const base = basePath === null ? [] : await measureCopy(linter, git(context.repo, ["show", `${context.from}:${basePath}`]), filePath)
  if (typeof head === "string") return { path, reason: head }
  if (typeof base === "string") return { path, reason: base }

  return { path, basePath, budget, head, paired: pairFunctions(base, head) }
}

/** A head function's entry; `pair` is undefined for a function new at the head. */
const toEntry = (file: FileMeasurement, head: MeasuredFunction, pair: FunctionPair | undefined): GrowthEntry => ({
  path: file.path,
  basePath: file.basePath,
  name: head.name,
  headLine: head.line,
  base: pair?.base.complexity ?? null,
  head: head.complexity,
  budget: file.budget.max,
  budgetSource: file.budget.source,
  pairedBy: pair?.pairedBy ?? null,
})

const isNotMeasured = (result: FileMeasurement | NotMeasured): result is NotMeasured => "reason" in result

const isMeasured = (result: FileMeasurement | NotMeasured): result is FileMeasurement => !isNotMeasured(result)

export const buildReport = (results: readonly (FileMeasurement | NotMeasured)[]): GrowthReport => {
  const measuredFiles = results.filter(isMeasured)
  const notMeasured = results.filter(isNotMeasured)
  const functions = measuredFiles.flatMap((file) => file.paired.pairs.map((pair) => toEntry(file, pair.head, pair)))
  const added = measuredFiles.flatMap((file) => file.paired.added.map((head) => toEntry(file, head, undefined)))
  const rose = measuredFiles.flatMap((file) => {
    return file.paired.pairs.filter((pair) => pair.head.complexity > pair.base.complexity).map((pair) => toEntry(file, pair.head, pair))
  })
  const listed = [...rose, ...added]
    .filter((entry) => entry.head > entry.budget)
    .toSorted((first, second) => first.path.localeCompare(second.path) || first.headLine - second.headLine)
  const measured = measuredFiles.reduce((total, file) => total + file.head.length, 0)
  const budgets = [...new Set(measuredFiles.map((file) => budgetLabel(file.budget)))]
  const line = formatLine({ status: "measured", measured, rose: rose.length, measuredFiles: measuredFiles.length, budgets, listed, notMeasured })
  return { line, measured, rose: rose.length, functions, listed, notMeasured }
}

const noEslintReport = (tooling: string): GrowthReport => {
  return { line: formatLine({ status: "no eslint", tooling }), measured: 0, rose: 0, functions: [], listed: [], notMeasured: [] }
}

const importFile = async (path: string): Promise<unknown> => import(pathToFileURL(path).href)

/** ESLint and the TypeScript parser from the tooling folder, or undefined when it has no ESLint. */
export const loadTooling = async (folder: string): Promise<Tooling | undefined> => {
  if (!existsSync(join(folder, "node_modules", "eslint"))) return undefined

  // Resolving from the folder finds its own node_modules first, which the check above proved holds ESLint.
  const eslintModule = await importFile(createRequire(join(folder, "package.json")).resolve("eslint"))
  const ESLint = isJsonObject(eslintModule) ? eslintModule.ESLint : undefined
  if (!isEslintConstructor(ESLint)) throw new Error(`${folder}/node_modules/eslint exports no ESLint class`)

  // The parser is optional, and `resolve` throws for a missing package, so the parser's file is tested for instead.
  const parserPath = join(folder, "node_modules", "@typescript-eslint", "parser", "dist", "index.js")
  const parser = existsSync(parserPath) ? await importFile(parserPath) : undefined
  return { ESLint, parser }
}

export const run = async (options: RunOptions): Promise<GrowthReport> => {
  const tooling = await loadTooling(options.tooling)
  if (!tooling) return noEslintReport(options.tooling)

  // The lowercase `d` excludes deleted files; an uppercase `D` would select only them.
  const nameStatus = git(options.repo, ["diff", "--name-status", "-M", "-z", "--diff-filter=d", options.from, options.to, "--"])
  // This instance loads the repo's own config only to read each file's budget; `createLinter`'s instances measure.
  const repoConfigEslint = new tooling.ESLint({ cwd: options.repo })
  const context: MeasureContext = { ...options, tooling, linters: new Map(), repoConfigEslint }
  const results: (FileMeasurement | NotMeasured)[] = []

  // Files are measured one at a time because each linter hands its syntax tree back through shared state.
  for (const file of selectFiles(nameStatus)) results.push(await measureFile(context, file))
  return buildReport(results)
}

const USAGE = `Usage: function-growth.ts --repo <folder> --from <commit> --to <commit> [--tooling <folder>] [--json]

Prints how each function's ESLint complexity changed between the two trees: the count that rose, and the
functions past the file's complexity budget. --tooling is where ESLint loads from (default: --repo).
`

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      tooling: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }
  if (!values.repo || !values.from || !values.to) throw new Error("--repo, --from and --to are required")
  // `--from` can come from a PR body; a leading dash would reach git as an option such as `--output=<file>`.
  if (values.from.startsWith("-") || values.to.startsWith("-")) throw new Error("--from and --to must name commits, not options")

  const report = await run({ repo: values.repo, from: values.from, to: values.to, tooling: values.tooling ?? values.repo })
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${report.line}\n`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(error instanceof GitError ? 2 : 1)
  }
}
