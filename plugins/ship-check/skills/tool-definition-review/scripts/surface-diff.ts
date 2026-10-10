#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
type JsonObject = { [key: string]: JsonValue }

export type Tool = {
  name: string
  inputSchema: JsonObject
  description: string | undefined
  title: string | undefined
  outputSchema: JsonObject | undefined
  annotations: JsonObject | undefined
}

// `sections` holds the server's `instructions` and `prompts` entries (see SECTION_KEYS).
export type Surface = { tools: Tool[]; sections: JsonObject }

type Part = "description" | "inputSchema" | "outputSchema" | "title" | "annotations"

type ToolSize = { name: string; description: number; inputSchema: number; outputSchema: number; total: number }

type TextChange = { added: string[]; removed: string[] }

type ToolChange = {
  name: string
  parts: Part[]
  sizeBefore: number
  sizeAfter: number
  descriptionLines: TextChange
  schemaSentences: TextChange
}

type SharedEdit = {
  text: string
  where: "description" | "schema"
  change: "added" | "removed"
  tools: string[]
}

// `preExisting` is true when the base surface already had the same overlap, so the change did not introduce it.
type Candidate = { tool: string; parameter: string; text: string; length: number; preExisting: boolean }

type ParameterText = { parameter: string; text: string }

// `changed` is null when there is no base, so "not compared" never reads as "unchanged".
type SectionChange = { name: string; changed: boolean | null }

export type Report = {
  current: string
  base: string | null
  changed: string[]
  added: string[]
  removed: string[]
  unchanged: string[]
  // Tools whose schemas or annotations differ only in JSON key order: same meaning, different serialisation.
  orderOnly: string[]
  inScope: string[]
  changes: ToolChange[]
  sizes: ToolSize[]
  totalSize: { base: number | null; current: number }
  sharedEdits: SharedEdit[]
  sections: SectionChange[]
  duplicationCandidates: Candidate[]
}

type VariantListing = {
  file: string
  differing: { name: string; parts: Part[] }[]
  onlyInCurrent: string[]
  onlyInVariant: string[]
}

/** Thrown for anything wrong with the arguments or the input files; the CLI exits 2 on it. */
export class InputError extends Error {}

// Overlaps shorter than this are mostly stock phrases a description and its
// schema both need ("Vault-relative path to the note"), not a repeated fact.
export const MIN_OVERLAP_CHARS = 40

// Top-level keys a snapshot file can carry beside its tool list.
const SECTION_KEYS = ["instructions", "prompts"]

const PARTS: Part[] = ["description", "inputSchema", "outputSchema", "title", "annotations"]

const SCHEMA_BRANCH_KEYS = ["anyOf", "oneOf", "allOf"]

// The whitespace after a sentence-ending mark; splitting on it keeps the mark with its sentence.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/

// A reviewer passes tool names to `--show` in a shell command, so a name from an untrusted file must not be able to carry shell syntax.
const COMMAND_LINE_SAFE_NAME = /^[A-Za-z0-9_.:/-]+$/

// Any run of spaces, tabs, or newlines.
const WHITESPACE_RUN = /\s+/g

// Overlaps are cut by UTF-16 code unit, so an edge can hold one half of a two-unit character such as an emoji.
const HALF_CHARACTER_AT_EDGE = /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g

const USAGE = [
  "Usage: surface-diff.ts --current <file> [--base <file>] [--names]",
  "       surface-diff.ts --current <file> --variants <file> [--variants <file> ...]",
  "       surface-diff.ts --current <file> --show <tool> [--show <tool> ...]",
  "       surface-diff.ts --plan --repo <dir> --from <ref> --to <ref> [--since <ref> --since-from <ref>] --out <new dir>",
].join("\n")

// One dispatch of the reviewer takes at most this many tools through its diff read (the skill's Scope rule 4).
export const TOOLS_PER_DISPATCH = 8

// Tool lists run to a few hundred kilobytes, but a changed lockfile or data file in the same range can be far
// larger, and execFileSync's 1 MiB default would fail on it.
const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024

const isJsonObject = (value: unknown): value is JsonObject => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown, field: string, where: string): string | undefined => {
  if (value === undefined || typeof value === "string") return value
  throw new InputError(`${where}: "${field}" must be a string`)
}

const optionalObject = (value: unknown, field: string, where: string): JsonObject | undefined => {
  if (value === undefined || isJsonObject(value)) return value
  throw new InputError(`${where}: "${field}" must be an object`)
}

const parseTool = (value: unknown, position: number, label: string): Tool => {
  if (!isJsonObject(value)) {
    throw new InputError(`${label}: tool ${position} is not an object`)
  }

  const { name, inputSchema } = value

  if (typeof name !== "string" || !name) {
    throw new InputError(`${label}: tool ${position} has no string "name"`)
  }

  if (!COMMAND_LINE_SAFE_NAME.test(name)) {
    throw new InputError(
      `${label}: tool ${position} is named ${JSON.stringify(name)}; a name may hold only letters, digits, and _ . : / - because the reviewer puts names on a command line`,
    )
  }

  const where = `${label}: tool "${name}"`

  if (!isJsonObject(inputSchema)) {
    throw new InputError(`${where}: "inputSchema" must be an object`)
  }

  return {
    name,
    inputSchema,
    description: optionalString(value.description, "description", where),
    title: optionalString(value.title, "title", where),
    outputSchema: optionalObject(value.outputSchema, "outputSchema", where),
    annotations: optionalObject(value.annotations, "annotations", where),
  }
}

const findToolList = (parsed: unknown, label: string): { tools: unknown[]; container: JsonObject | null } => {
  if (Array.isArray(parsed)) return { tools: parsed, container: null }
  if (isJsonObject(parsed) && Array.isArray(parsed.tools)) return { tools: parsed.tools, container: parsed }
  if (isJsonObject(parsed) && isJsonObject(parsed.result) && Array.isArray(parsed.result.tools)) {
    return { tools: parsed.result.tools, container: parsed.result }
  }

  throw new InputError(
    `${label}: not a tool list (expected a "tools" array, a bare array of tools, or a JSON-RPC result holding "tools")`,
  )
}

export const parseSurface = (parsed: unknown, label: string): Surface => {
  const { tools: rawTools, container } = findToolList(parsed, label)

  // A cursor means the server had more tools to send; comparing one page would report the rest as removed.
  if (container?.nextCursor) {
    throw new InputError(`${label}: has "nextCursor", so it is one page of a longer list; capture every page`)
  }

  const tools = rawTools.map((rawTool, index) => parseTool(rawTool, index + 1, label))

  const seenNames = new Set<string>()

  for (const { name } of tools) {
    if (seenNames.has(name)) {
      throw new InputError(`${label}: two tools are named "${name}"`)
    }

    seenNames.add(name)
  }

  const sectionEntries = Object.entries(container ?? {}).filter(([key]) => SECTION_KEYS.includes(key))

  return { tools, sections: Object.fromEntries(sectionEntries) }
}

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    throw new InputError(`${path}: cannot be read`)
  }
}

const parseJson = (text: string, path: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new InputError(`${path}: not valid JSON`)
  }
}

const loadSurface = (path: string): Surface => parseSurface(parseJson(readText(path), path), path)

/** Sorts object keys at every depth, so schemas that differ only in key order serialise alike. Array order is kept, because it is part of a schema's meaning. */
const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (!isJsonObject(value)) {
    return value
  }

  const sortedEntries = Object.entries(value).toSorted(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : 1))
  return Object.fromEntries(sortedEntries.map(([key, child]) => [key, canonicalize(child)]))
}

// An absent part serialises as the empty string, which no present value does, so absent and present never compare equal.
const canonicalJson = (value: JsonValue | undefined): string => {
  return value === undefined ? "" : JSON.stringify(canonicalize(value))
}

// Same as `canonicalJson` but without sorting keys, so two tools that differ only in key order produce different strings.
const wireJson = (value: JsonValue | undefined): string => (value === undefined ? "" : JSON.stringify(value))

export const changedParts = (base: Tool, current: Tool): Part[] => {
  return PARTS.filter((part) => canonicalJson(base[part]) !== canonicalJson(current[part]))
}

const differsOnlyInKeyOrder = (base: Tool, current: Tool): boolean => {
  const sameMeaning = changedParts(base, current).length === 0
  return sameMeaning && PARTS.some((part) => wireJson(base[part]) !== wireJson(current[part]))
}

// A tool may ship no description; it is compared and measured as empty text.
const descriptionOf = (tool: Tool | undefined): string => tool?.description ?? ""

const toolSize = (tool: Tool): ToolSize => {
  const description = descriptionOf(tool).length
  const inputSchema = JSON.stringify(tool.inputSchema).length
  const outputSchema = tool.outputSchema ? JSON.stringify(tool.outputSchema).length : 0

  return { name: tool.name, description, inputSchema, outputSchema, total: description + inputSchema + outputSchema }
}

const sumSizes = (tools: Tool[]): number => tools.reduce((sum, tool) => sum + toolSize(tool).total, 0)

const nonEmptyTrimmed = (texts: string[]): string[] => texts.map((text) => text.trim()).filter(Boolean)

const descriptionLines = (tool: Tool): string[] => nonEmptyTrimmed(descriptionOf(tool).split("\n"))

const collectDescriptions = (schema: JsonValue | undefined): string[] => {
  if (Array.isArray(schema)) {
    return schema.flatMap(collectDescriptions)
  }

  if (!isJsonObject(schema)) {
    return []
  }

  const own = typeof schema.description === "string" ? [schema.description] : []
  return [...own, ...Object.values(schema).flatMap(collectDescriptions)]
}

const schemaSentences = (tool: Tool): string[] => {
  const descriptions = [...collectDescriptions(tool.inputSchema), ...collectDescriptions(tool.outputSchema)]
  return descriptions.flatMap((description) => nonEmptyTrimmed(description.split(SENTENCE_BOUNDARY)))
}

const countCopies = (texts: string[]): Map<string, number> => {
  const copies = new Map<string, number>()

  for (const text of texts) {
    copies.set(text, (copies.get(text) ?? 0) + 1)
  }

  return copies
}

const textsWithMoreCopies = (copies: Map<string, number>, thanIn: Map<string, number>): string[] => {
  return [...copies.keys()].filter((text) => (copies.get(text) ?? 0) > (thanIn.get(text) ?? 0))
}

/** Compares how many copies of each text there are, so losing one of two identical lines is still a removal. Each text is listed once. */
const textChange = (before: string[], after: string[]): TextChange => {
  const copiesBefore = countCopies(before)
  const copiesAfter = countCopies(after)

  return {
    added: textsWithMoreCopies(copiesAfter, copiesBefore),
    removed: textsWithMoreCopies(copiesBefore, copiesAfter),
  }
}

const describeChange = (base: Tool, current: Tool): ToolChange => {
  return {
    name: current.name,
    parts: changedParts(base, current),
    sizeBefore: toolSize(base).total,
    sizeAfter: toolSize(current).total,
    descriptionLines: textChange(descriptionLines(base), descriptionLines(current)),
    schemaSentences: textChange(schemaSentences(base), schemaSentences(current)),
  }
}

const editsOf = (
  { name, descriptionLines: lines, schemaSentences: sentences }: ToolChange,
): SharedEdit[] => {
  return [
    ...lines.added.map((text) => ({ text, where: "description" as const, change: "added" as const, tools: [name] })),
    ...lines.removed.map((text) => ({ text, where: "description" as const, change: "removed" as const, tools: [name] })),
    ...sentences.added.map((text) => ({ text, where: "schema" as const, change: "added" as const, tools: [name] })),
    ...sentences.removed.map((text) => ({ text, where: "schema" as const, change: "removed" as const, tools: [name] })),
  ]
}

/** Groups identical added or removed text across tools. Text that touched one tool stays on that tool's own change record. */
export const findSharedEdits = (changes: ToolChange[]): SharedEdit[] => {
  const editsByKey = new Map<string, SharedEdit>()

  for (const edit of changes.flatMap(editsOf)) {
    const key = JSON.stringify([edit.where, edit.change, edit.text])
    const toolsSoFar = editsByKey.get(key)?.tools ?? []
    editsByKey.set(key, { ...edit, tools: [...toolsSoFar, ...edit.tools] })
  }

  return [...editsByKey.values()].filter((edit) => edit.tools.length > 1)
}

const collapseWhitespace = (text: string): string => text.replace(WHITESPACE_RUN, " ").trim()

const childPath = (path: string, name: string): string => (path ? `${path}.${name}` : name)

const branchTexts = (schema: JsonObject, path: string): ParameterText[] => {
  return SCHEMA_BRANCH_KEYS.flatMap((key) => {
    const options = schema[key]
    return Array.isArray(options) ? options.flatMap((option) => parameterTexts(option, path)) : []
  })
}

/** Every described parameter in a schema, with a dotted path. Branches of anyOf, oneOf, and allOf describe the same parameter, so they keep its path. */
export const parameterTexts = (schema: JsonValue | undefined, path = ""): ParameterText[] => {
  if (!isJsonObject(schema)) return []

  // The root schema's own description belongs to no parameter.
  const describesParameter = path !== "" && typeof schema.description === "string"
  const own = describesParameter ? [{ parameter: path, text: String(schema.description) }] : []

  const properties = isJsonObject(schema.properties) ? Object.entries(schema.properties) : []
  const nested = properties.flatMap(([name, child]) => parameterTexts(child, childPath(path, name)))

  return [...own, ...nested, ...parameterTexts(schema.items, `${path}[]`), ...branchTexts(schema, path)]
}

const longestCommonSubstring = (left: string, right: string): string => {
  // Dynamic programming over two rows; bestLength/bestEnd track the winner so far.
  let bestLength = 0
  let bestEnd = 0
  let previousRow = new Uint32Array(right.length + 1)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const row = new Uint32Array(right.length + 1)

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue

      const runLength = (previousRow[rightIndex - 1] ?? 0) + 1
      row[rightIndex] = runLength

      if (runLength > bestLength) {
        bestLength = runLength
        bestEnd = leftIndex
      }
    }

    previousRow = row
  }

  return left.slice(bestEnd - bestLength, bestEnd)
}

/** Every non-overlapping stretch of `text`, at least MIN_OVERLAP_CHARS long, that also appears in `other`. Longest first. */
export const commonSubstrings = (text: string, other: string): string[] => {
  const longest = longestCommonSubstring(text, other)

  if (longest.length < MIN_OVERLAP_CHARS) return []

  const start = text.indexOf(longest)
  const before = text.slice(0, start)
  const after = text.slice(start + longest.length)

  // When the same substring appears twice in `text`, both halves produce it, so the Set keeps one copy.
  const overlaps = new Set([longest, ...commonSubstrings(before, other), ...commonSubstrings(after, other)])
  return [...overlaps].toSorted((leftText, rightText) => rightText.length - leftText.length)
}

const findCandidates = (tool: Tool, base: Tool | undefined): Candidate[] => {
  const description = collapseWhitespace(descriptionOf(tool))
  const baseDescription = collapseWhitespace(descriptionOf(base))
  const baseParameters = parameterTexts(base?.inputSchema)

  const baseRepeated = (parameter: string, overlap: string): boolean => {
    const sameParameter = baseParameters.filter((baseParameter) => baseParameter.parameter === parameter)
    const inBaseSchema = sameParameter.some((baseParameter) => collapseWhitespace(baseParameter.text).includes(overlap))

    return inBaseSchema && baseDescription.includes(overlap)
  }

  return parameterTexts(tool.inputSchema).flatMap(({ parameter, text }) => {
    // An overlap loses a half character and the spaces at its edges, so it matches the base's
    // repetition even when the change added a space beside it. The threshold is checked again
    // because that trimming can shorten an overlap below it.
    const overlaps = commonSubstrings(collapseWhitespace(text), description)
      .map((overlap) => overlap.replace(HALF_CHARACTER_AT_EDGE, "").trim())
      .filter((overlap) => overlap.length >= MIN_OVERLAP_CHARS)

    return overlaps.map((overlap) => ({
      tool: tool.name,
      parameter,
      text: overlap,
      length: overlap.length,
      preExisting: baseRepeated(parameter, overlap),
    }))
  })
}

const compareSections = (base: Surface | null, current: Surface): SectionChange[] => {
  const present = SECTION_KEYS.filter((key) => key in current.sections || (base !== null && key in base.sections))

  return present.map((key) => ({
    name: key,
    changed: base ? canonicalJson(base.sections[key]) !== canonicalJson(current.sections[key]) : null,
  }))
}

export const compareSurfaces = (
  base: Surface | null,
  current: Surface,
  paths: { base: string | null; current: string },
): Report => {
  const baseTools = base ? base.tools : []
  const baseByName = new Map(baseTools.map((tool) => [tool.name, tool]))
  const currentNames = new Set(current.tools.map((tool) => tool.name))

  const pairs = current.tools.flatMap((tool) => {
    const baseTool = baseByName.get(tool.name)
    return baseTool ? [{ baseTool, tool }] : []
  })

  const changedPairs = pairs.filter(({ baseTool, tool }) => changedParts(baseTool, tool).length > 0)
  const changes = changedPairs.map(({ baseTool, tool }) => describeChange(baseTool, tool))
  const changed = changes.map((change) => change.name)

  const added = base ? current.tools.filter((tool) => !baseByName.has(tool.name)).map((tool) => tool.name) : []
  const removed = baseTools.filter((tool) => !currentNames.has(tool.name)).map((tool) => tool.name)
  const unchanged = pairs.map(({ tool }) => tool.name).filter((name) => !changed.includes(name))
  const orderOnlyPairs = pairs.filter(({ baseTool, tool }) => differsOnlyInKeyOrder(baseTool, tool))

  // Without a base nothing is known to be untouched, so every tool is reviewed.
  const inScopeNames = new Set(base ? [...changed, ...added] : currentNames)
  const inScopeTools = current.tools.filter((tool) => inScopeNames.has(tool.name))

  return {
    current: paths.current,
    base: paths.base,
    changed,
    added,
    removed,
    unchanged,
    orderOnly: orderOnlyPairs.map(({ tool }) => tool.name),
    inScope: inScopeTools.map((tool) => tool.name),
    changes,
    sizes: inScopeTools.map(toolSize),
    totalSize: { base: base ? sumSizes(base.tools) : null, current: sumSizes(current.tools) },
    sharedEdits: findSharedEdits(changes),
    sections: compareSections(base, current),
    duplicationCandidates: inScopeTools.flatMap((tool) => findCandidates(tool, baseByName.get(tool.name))),
  }
}

const listVariant = (current: Surface, file: string, variant: Surface): VariantListing => {
  const variantByName = new Map(variant.tools.map((tool) => [tool.name, tool]))
  const currentNames = new Set(current.tools.map((tool) => tool.name))

  const differing = current.tools.flatMap((tool) => {
    const variantTool = variantByName.get(tool.name)

    if (!variantTool) return []

    const parts = changedParts(tool, variantTool)
    return parts.length > 0 ? [{ name: tool.name, parts }] : []
  })

  return {
    file,
    differing,
    onlyInCurrent: current.tools.filter((tool) => !variantByName.has(tool.name)).map((tool) => tool.name),
    onlyInVariant: variant.tools.filter((tool) => !currentNames.has(tool.name)).map((tool) => tool.name),
  }
}

/** For each other configuration's file, the tools it words differently from `current`. */
export const listVariants = (current: Surface, variants: { file: string; surface: Surface }[]): VariantListing[] => {
  return variants.map(({ file, surface }) => listVariant(current, file, surface))
}

const formatTool = (tool: Tool): string => {
  const title = tool.title ? [`title: ${tool.title}`] : []
  const outputSchema = tool.outputSchema ? ["", "outputSchema:", JSON.stringify(tool.outputSchema, null, 2)] : []
  const annotations = tool.annotations ? ["", `annotations: ${JSON.stringify(tool.annotations)}`] : []

  return [
    `=== ${tool.name} ===`,
    ...title,
    "description:",
    descriptionOf(tool),
    "",
    "inputSchema:",
    JSON.stringify(tool.inputSchema, null, 2),
    ...outputSchema,
    ...annotations,
  ].join("\n")
}

/** The named tools as readable text. A surface file keeps each description on one long JSON line, which file viewers cut off. */
export const showTools = (surface: Surface, names: string[], label: string): string => {
  const toolsByName = new Map(surface.tools.map((tool) => [tool.name, tool]))

  const shown = names.map((name) => {
    const tool = toolsByName.get(name)

    if (!tool) {
      throw new InputError(`${label}: no tool named ${JSON.stringify(name)}`)
    }

    return formatTool(tool)
  })

  return shown.join("\n\n")
}

/** A path's content at one commit, as `--plan` reads it. */
export type FileSide =
  | { kind: "absent" }
  | { kind: "toolList"; surface: Surface; text: string }
  | { kind: "notToolList"; reason: string }

/** The commits a `--since` review compares beyond `--from` and `--to`, read at the path the file had at the review. */
export type SinceSides = { path: string; since: FileSide; sinceFrom: FileSide }

/** One changed `.json` path. `path` is its path at `--to`; `fromPath` differs only when the file was renamed. */
export type ChangedFile = {
  path: string
  fromPath: string
  from: FileSide
  to: FileSide
  sinceSides: SinceSides | null
}

type ReviewRecord = {
  name: string
  // Equal keys are one review: the tool's name with its definition before and after.
  key: string
  // Equal edits need the error trace only once.
  edit: string
  // The tool's definition at `--to`, matched by the new-file rule.
  definition: string
  alsoChangedOnBaseBranch: boolean
}

/**
 * What the reviewer compares a file with.
 * - `fromCopy`: the file as git holds it at `--from`, at its path there.
 * - `composed`: a `--since` base built from several commits, written at the file's `--to` path.
 */
export type ReviewBase =
  | { kind: "fromCopy"; path: string }
  | { kind: "composed"; path: string; tools: Tool[]; sections: JsonObject }

type FileReview = {
  path: string
  base: ReviewBase | null
  records: ReviewRecord[]
  // Every tool definition the file ships at `--to`, in scope or not.
  shippedDefinitions: ReadonlySet<string>
}

export type PlannedFile = {
  path: string
  reviewOnly: string[]
  withRoot: boolean
  coldDispatch: boolean
  batches: string[][]
  alsoChangedOnBaseBranch: string[]
  // Null for a new tool-list file, which has nothing to compare with.
  base: ReviewBase | null
}

export type PlanResult = {
  records: number
  files: PlannedFile[]
  filesWithNoToolChange: string[]
  broken: { path: string; reason: string }[]
  removed: { path: string; tools: string[] }[]
  removedTools: { path: string; tools: string[] }[]
  addedThenDropped: { path: string; tools: string[] }[]
  notToolLists: string[]
}

const TOOL_PARTS_ORDER: Part[] = ["title", "description", "inputSchema", "outputSchema", "annotations"]

/** The tool as one JSON object holding only its present parts, so it can be compared and keyed. */
const toolObject = (tool: Tool): JsonObject => {
  const presentParts = TOOL_PARTS_ORDER.flatMap((part) => {
    const value = tool[part]
    return value === undefined ? [] : [[part, value] as const]
  })

  return Object.fromEntries([["name", tool.name], ...presentParts])
}

// An absent tool keys as the empty string, which no present tool does.
const toolKey = (tool: Tool | undefined): string => (tool ? canonicalJson(toolObject(tool)) : "")

const sameTool = (left: Tool | undefined, right: Tool | undefined): boolean => toolKey(left) === toolKey(right)

const byCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Removes string `description` values at every depth. A parameter named `description` holds an object, so it stays. */
const withoutDescriptionText = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(withoutDescriptionText)
  }

  if (!isJsonObject(value)) {
    return value
  }

  const kept = Object.entries(value).filter(([key, child]) => !(key === "description" && typeof child === "string"))
  return Object.fromEntries(kept.map(([key, child]) => [key, withoutDescriptionText(child)]))
}

/** Every node of a JSON value by its path. Containers get an entry too, so adding an empty object or array is a change. */
const nodesByPath = (value: JsonValue, path = ""): [string, string][] => {
  if (Array.isArray(value)) {
    return [[path, "[]"], ...value.flatMap((child, index) => nodesByPath(child, `${path}/${index}`))]
  }

  if (isJsonObject(value)) {
    return [[path, "{}"], ...Object.entries(value).flatMap(([key, child]) => nodesByPath(child, `${path}/${key}`))]
  }

  return [[path, JSON.stringify(value)]]
}

/** The non-description parts of a tool whose values changed, as sorted path, before, after triples. */
const changedSchemaNodes = (base: Tool, current: Tool): [string, string | null, string | null][] => {
  const structure = (tool: Tool): Map<string, string> => {
    const { description: _description, ...rest } = toolObject(tool)
    return new Map(nodesByPath(withoutDescriptionText(rest)))
  }

  const before = structure(base)
  const after = structure(current)
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted(byCodeUnit)

  return paths
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => [path, before.get(path) ?? null, after.get(path) ?? null])
}

/** What a change did to one tool, independent of the wording it did not touch. An added tool's edit is its whole definition. */
const editKey = (name: string, base: Tool | undefined, current: Tool): string => {
  if (!base) return JSON.stringify([name, "added", toolKey(current)])

  const lines = textChange(descriptionLines(base), descriptionLines(current))
  const sentences = textChange(schemaSentences(base), schemaSentences(current))

  return JSON.stringify([
    name,
    lines.added.toSorted(byCodeUnit),
    lines.removed.toSorted(byCodeUnit),
    sentences.added.toSorted(byCodeUnit),
    sentences.removed.toSorted(byCodeUnit),
    changedSchemaNodes(base, current),
  ])
}

const recordFor = (base: Tool | undefined, current: Tool, alsoChangedOnBaseBranch: boolean): ReviewRecord => {
  return {
    name: current.name,
    key: JSON.stringify([current.name, toolKey(base), toolKey(current)]),
    edit: editKey(current.name, base, current),
    definition: toolKey(current),
    alsoChangedOnBaseBranch,
  }
}

const fileReview = (path: string, base: ReviewBase | null, records: ReviewRecord[], current: Surface): FileReview => {
  return { path, base, records, shippedDefinitions: new Set(current.tools.map(toolKey)) }
}

const toolsByName = (side: FileSide): Map<string, Tool> => {
  return side.kind === "toolList" ? new Map(side.surface.tools.map((tool) => [tool.name, tool])) : new Map()
}

const sameSide = (left: FileSide, right: FileSide): boolean => {
  if (left.kind !== "toolList" || right.kind !== "toolList") return left.kind === right.kind

  const leftKey = canonicalJson({ ...left.surface.sections, tools: left.surface.tools.map(toolObject) })
  const rightKey = canonicalJson({ ...right.surface.sections, tools: right.surface.tools.map(toolObject) })
  return leftKey === rightKey
}

type SinceDecision = { inScope: false } | { inScope: true; base: Tool | undefined; alsoChangedOnBaseBranch: boolean }

/**
 * Whether a tool needs review since the last one, and what to compare it with. The first matching rule applies:
 * 1. The branch never touched it (unchanged from the old merge base to the review, and equal to the new merge base now): no.
 * 2. Changed since the review, first touched after it: yes, against the new merge base.
 * 3. Changed since the review, touched before it: yes, against the reviewed text.
 * 4. Unchanged since the review, but the base branch changed it and the branch's text overrode that: yes, against the new merge base.
 */
export const decideSince = (definitions: {
  since: Tool | undefined
  sinceFrom: Tool | undefined
  from: Tool | undefined
  to: Tool | undefined
}): SinceDecision => {
  const { since, sinceFrom, from, to } = definitions
  const baseBranchMoved = !sameTool(sinceFrom, from)

  if (sameTool(since, sinceFrom) && sameTool(to, from)) return { inScope: false }

  if (!sameTool(to, since)) {
    const firstTouchedAfterReview = sameTool(since, sinceFrom)
    return { inScope: true, base: firstTouchedAfterReview ? from : since, alsoChangedOnBaseBranch: baseBranchMoved }
  }

  if (baseBranchMoved && !sameTool(to, from)) return { inScope: true, base: from, alsoChangedOnBaseBranch: true }

  return { inScope: false }
}

type Classified =
  | { kind: "review"; review: FileReview; removedTools: string[]; addedThenDropped: string[] }
  | { kind: "broken"; reason: string }
  | { kind: "removed"; tools: string[] }
  | { kind: "addedThenDropped"; tools: string[] }
  | { kind: "excluded" }
  | { kind: "notToolList" }

const toolNames = (side: FileSide): string[] => (side.kind === "toolList" ? side.surface.tools.map((tool) => tool.name) : [])

const classifyFull = (file: ChangedFile): Classified => {
  const { from, to } = file

  if (to.kind === "notToolList") {
    return from.kind === "toolList" ? { kind: "broken", reason: to.reason } : { kind: "notToolList" }
  }

  if (to.kind === "absent") {
    return from.kind === "toolList" ? { kind: "removed", tools: toolNames(from) } : { kind: "notToolList" }
  }

  const base = from.kind === "toolList" ? from.surface : null
  const report = compareSurfaces(base, to.surface, { base: file.fromPath, current: file.path })
  const baseTools = toolsByName(from)

  const records = to.surface.tools
    .filter((tool) => report.inScope.includes(tool.name))
    .map((tool) => recordFor(baseTools.get(tool.name), tool, false))

  const reviewBase: ReviewBase | null = base ? { kind: "fromCopy", path: file.fromPath } : null
  const review = fileReview(file.path, reviewBase, records, to.surface)
  return { kind: "review", review, removedTools: report.removed, addedThenDropped: [] }
}

/** The composed `--since` base: each in-scope tool's chosen base, and the `--to` version of every other tool and of the sections. */
const composeSinceBase = (to: Surface, bases: ReadonlyMap<string, Tool | undefined>): { tools: Tool[]; sections: JsonObject } => {
  const tools = to.tools.flatMap((tool) => {
    if (!bases.has(tool.name)) return [tool]

    const base = bases.get(tool.name)
    return base ? [base] : []
  })

  return { tools, sections: to.sections }
}

const classifySince = (file: ChangedFile, sinceSides: SinceSides): Classified => {
  const { from, to } = file

  // A file absent at the review compares as it stood on the base branch at both merge bases.
  const sinceAbsent = sinceSides.since.kind === "absent"
  const since = sinceAbsent ? from : sinceSides.since
  const sinceFrom = sinceAbsent ? from : sinceSides.sinceFrom

  if (to.kind === "notToolList") {
    return since.kind === "toolList" ? { kind: "broken", reason: to.reason } : { kind: "notToolList" }
  }

  if (to.kind === "absent") {
    if (since.kind !== "toolList") return { kind: "notToolList" }
    if (sameSide(since, sinceFrom) && from.kind === "absent") return { kind: "excluded" }
    if (sinceFrom.kind === "absent" && from.kind === "absent") return { kind: "addedThenDropped", tools: toolNames(since) }

    return { kind: "removed", tools: toolNames(since) }
  }

  const [sinceTools, sinceFromTools, fromTools] = [toolsByName(since), toolsByName(sinceFrom), toolsByName(from)]
  const bases = new Map<string, Tool | undefined>()
  const records: ReviewRecord[] = []

  for (const tool of to.surface.tools) {
    const decision = decideSince({
      since: sinceTools.get(tool.name),
      sinceFrom: sinceFromTools.get(tool.name),
      from: fromTools.get(tool.name),
      to: tool,
    })

    if (!decision.inScope) continue

    bases.set(tool.name, decision.base)
    records.push(recordFor(decision.base, tool, decision.alsoChangedOnBaseBranch))
  }

  const currentNames = new Set(to.surface.tools.map((tool) => tool.name))
  const goneSinceReview = [...sinceTools.values()].filter((tool) => !currentNames.has(tool.name))

  const baseBranchRemoval = (tool: Tool): boolean => sameTool(tool, sinceFromTools.get(tool.name)) && !fromTools.has(tool.name)
  const branchAddedThenDropped = (tool: Tool): boolean => !sinceFromTools.has(tool.name) && !fromTools.has(tool.name)

  const reported = goneSinceReview.filter((tool) => !baseBranchRemoval(tool))
  const addedThenDropped = reported.filter(branchAddedThenDropped).map((tool) => tool.name)
  const removedTools = reported.filter((tool) => !branchAddedThenDropped(tool)).map((tool) => tool.name)

  const reviewBase: ReviewBase | null =
    since.kind === "toolList" ? { kind: "composed", path: file.path, ...composeSinceBase(to.surface, bases) } : null
  const review = fileReview(file.path, reviewBase, records, to.surface)
  return { kind: "review", review, removedTools, addedThenDropped }
}

const chunk = (names: readonly string[], size: number): string[][] => {
  const chunks: string[][] = []

  for (let start = 0; start < names.length; start += size) {
    chunks.push(names.slice(start, start + size))
  }

  return chunks
}

/**
 * A new file's tool needs no review when a changed file that has a base already ships the same definition: its text is
 * either unchanged elsewhere or reviewed there. Unchanged files are not read, so an added copy of one is still reviewed.
 */
const dropToolsShippedElsewhere = (reviews: readonly FileReview[]): FileReview[] => {
  const shippedWithBase = new Set(reviews.filter((review) => review.base).flatMap((review) => [...review.shippedDefinitions]))

  return reviews.map((review) => {
    if (review.base) return review

    return { ...review, records: review.records.filter((record) => !shippedWithBase.has(record.definition)) }
  })
}

/**
 * Gives each record to the first file in the order that holds it, and the repository root to each file holding a new edit.
 * A file's records are already distinct, since each carries a different tool name.
 */
const assignRecords = (reviews: readonly FileReview[]): PlannedFile[] => {
  const ordered = reviews.toSorted(
    (left, right) => right.records.length - left.records.length || byCodeUnit(left.path, right.path),
  )

  // Both sets grow across files: a record or an edit belongs to the first file in the order that holds it.
  const assignedKeys = new Set<string>()
  const tracedEdits = new Set<string>()
  const planned: PlannedFile[] = []

  for (const review of ordered) {
    const assigned: ReviewRecord[] = []

    for (const record of review.records) {
      if (assignedKeys.has(record.key)) continue

      assignedKeys.add(record.key)
      assigned.push(record)
    }

    if (assigned.length === 0) continue

    const newEdits = assigned.filter((record) => !tracedEdits.has(record.edit))

    for (const record of newEdits) {
      tracedEdits.add(record.edit)
    }

    const names = assigned.map((record) => record.name)

    planned.push({
      path: review.path,
      reviewOnly: names,
      withRoot: newEdits.length > 0,
      coldDispatch: names.length > TOOLS_PER_DISPATCH,
      batches: chunk(names, TOOLS_PER_DISPATCH),
      alsoChangedOnBaseBranch: assigned.filter((record) => record.alsoChangedOnBaseBranch).map((record) => record.name),
      base: review.base,
    })
  }

  return planned
}

/**
 * Turns the changed files into the reviewer's dispatches.
 * - One record per distinct tool definition before and after; equal records across files are reviewed once.
 * - Files are ordered by how many distinct records they hold, most first, then by path in code-unit order.
 * - A file gets the repository root when it holds the first record of some edit, so each distinct edit is traced once.
 */
export const planReview = (files: readonly ChangedFile[]): PlanResult => {
  const classified = files.map((file) => ({
    path: file.path,
    result: file.sinceSides ? classifySince(file, file.sinceSides) : classifyFull(file),
  }))

  const reviewResults = classified.flatMap(({ path, result }) => (result.kind === "review" ? [{ path, ...result }] : []))
  const eligible = dropToolsShippedElsewhere(reviewResults.map(({ review }) => review))
  const planned = assignRecords(eligible)
  const eligibleCounts = new Map(eligible.map((review) => [review.path, review.records.length]))

  const quiet = reviewResults.filter(({ path, removedTools, addedThenDropped }) => {
    return !eligibleCounts.get(path) && removedTools.length === 0 && addedThenDropped.length === 0
  })

  const removedTools = reviewResults.flatMap(({ path, removedTools: tools }) => (tools.length > 0 ? [{ path, tools }] : []))

  const droppedTools = reviewResults.flatMap(({ path, addedThenDropped: tools }) => {
    return tools.length > 0 ? [{ path, tools }] : []
  })

  const droppedFiles = classified.flatMap(({ path, result }) => {
    return result.kind === "addedThenDropped" ? [{ path, tools: result.tools }] : []
  })

  return {
    records: planned.reduce((sum, file) => sum + file.reviewOnly.length, 0),
    files: planned,
    filesWithNoToolChange: quiet.map(({ path }) => path),
    broken: classified.flatMap(({ path, result }) => (result.kind === "broken" ? [{ path, reason: result.reason }] : [])),
    removed: classified.flatMap(({ path, result }) => (result.kind === "removed" ? [{ path, tools: result.tools }] : [])),
    removedTools,
    addedThenDropped: [...droppedFiles, ...droppedTools],
    notToolLists: classified.filter(({ result }) => result.kind === "notToolList").map(({ path }) => path),
  }
}

/** Git's own message when it printed one, since execFileSync's error message only says the command failed. */
const gitErrorText = (error: unknown): string => {
  if (isJsonObject(error) && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim()
  }

  return error instanceof Error ? error.message : String(error)
}

/** Runs one read-only git command with an argument list, so nothing in a path or ref reaches a shell. */
const runGit = (repo: string, args: string[]): string => {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    throw new InputError(`git ${args.join(" ")}: ${gitErrorText(error)}`)
  }
}

const resolveCommit = (repo: string, ref: string): string => {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new InputError(`${ref}: not a commit in ${repo}`)
  }
}

type PathChange = { path: string; oldPath: string }

/**
 * Parses `git diff -z --name-status` output: a status, then one path, or two for a rename (old, then new).
 * A copy is not detected without `-C`, so every non-rename status carries one path.
 */
const parseNameStatus = (output: string): PathChange[] => {
  // Every field ends with a NUL, so splitting leaves one empty field at the end.
  const fields = output.split("\0").slice(0, -1)
  const changes: PathChange[] = []
  // An entry takes two fields or, for a rename, three, so the loop advances by each entry's own length.
  let index = 0

  while (index < fields.length) {
    const [status, first, second] = fields.slice(index, index + 3)

    if (!status || !first) {
      throw new InputError("git diff: an entry ended before its path")
    }

    if (status.startsWith("R")) {
      if (!second) throw new InputError(`git diff: the rename of ${first} has no new path`)

      changes.push({ path: second, oldPath: first })
      index += 3
      continue
    }

    changes.push({ path: first, oldPath: first })
    index += 2
  }

  return changes
}

// A user's git config can turn on colour or an external diff program, either of which would corrupt the parsed output.
const DIFF_OUTPUT_OPTIONS = ["-z", "--name-status", "-M", "--no-color", "--no-ext-diff"]

const listChangedJson = (repo: string, fromCommit: string, toCommit: string): PathChange[] => {
  return parseNameStatus(runGit(repo, ["diff", ...DIFF_OUTPUT_OPTIONS, fromCommit, toCommit, "--", "*.json"]))
}

const pathExists = (repo: string, commit: string, path: string): boolean => {
  return runGit(repo, ["ls-tree", "-z", "--name-only", commit, "--", path]) !== ""
}

const parseJsonText = (text: string): { parsed: unknown } | null => {
  try {
    return { parsed: JSON.parse(text) }
  } catch {
    return null
  }
}

const readSide = (repo: string, commit: string, path: string): FileSide => {
  if (!pathExists(repo, commit, path)) return { kind: "absent" }

  const text = runGit(repo, ["show", `${commit}:${path}`])
  const json = parseJsonText(text)

  if (!json) return { kind: "notToolList", reason: `${path}: not valid JSON` }

  try {
    return { kind: "toolList", surface: parseSurface(json.parsed, path), text }
  } catch (error) {
    if (!(error instanceof InputError)) throw error

    return { kind: "notToolList", reason: error.message }
  }
}

type PlanCommits = { from: string; to: string; since: string | null; sinceFrom: string | null }

/** Reads every changed `.json` path at each commit the plan compares. */
const readChangedFiles = (repo: string, commits: PlanCommits): ChangedFile[] => {
  const { from, to, since, sinceFrom } = commits
  const fromChanges = listChangedJson(repo, from, to)
  const fromPaths = new Map(fromChanges.map((change) => [change.path, change.oldPath]))

  if (!since || !sinceFrom) {
    return fromChanges.map((change) => ({
      path: change.path,
      fromPath: change.oldPath,
      from: readSide(repo, from, change.oldPath),
      to: readSide(repo, to, change.path),
      sinceSides: null,
    }))
  }

  const sinceChanges = listChangedJson(repo, since, to)
  const sincePaths = new Map(sinceChanges.map((change) => [change.path, change.oldPath]))

  // When the merge base moved, a path the base branch changed is checked too: a merge may have kept the branch's text over it.
  const baseBranchChanges = sinceFrom === from ? [] : listChangedJson(repo, sinceFrom, from)
  const paths = [...new Set([...sinceChanges, ...baseBranchChanges].map((change) => change.path))].toSorted(byCodeUnit)

  return paths.map((path) => {
    const fromPath = fromPaths.get(path) ?? path
    const sincePath = sincePaths.get(path) ?? path

    return {
      path,
      fromPath,
      from: readSide(repo, from, fromPath),
      to: readSide(repo, to, path),
      sinceSides: {
        path: sincePath,
        since: readSide(repo, since, sincePath),
        sinceFrom: readSide(repo, sinceFrom, sincePath),
      },
    }
  })
}

const writeTextFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const createOutputFolder = (out: string) => {
  try {
    mkdirSync(out)
  } catch (error) {
    const code = isJsonObject(error) ? error.code : undefined

    if (code === "EEXIST") throw new InputError(`${out}: already exists; --out must name a new folder`)
    if (code === "ENOENT") throw new InputError(`${out}: its parent folder does not exist`)
    throw error
  }
}

/** Writes each side the plan read, and each composed `--since` base, under `out`; returns the plan with those paths. */
const writePlan = (out: string, files: readonly ChangedFile[], result: PlanResult) => {
  createOutputFolder(out)

  for (const file of files) {
    if (file.from.kind === "toolList") writeTextFile(join(out, "from", file.fromPath), file.from.text)
    if (file.to.kind === "toolList") writeTextFile(join(out, "to", file.path), file.to.text)

    const { sinceSides } = file

    if (sinceSides?.since.kind === "toolList") writeTextFile(join(out, "since", sinceSides.path), sinceSides.since.text)
  }

  const basePathFor = ({ base }: PlannedFile): string | null => {
    if (!base) return null
    if (base.kind === "fromCopy") return join(out, "from", base.path)

    const composedPath = join(out, "since-base", base.path)
    const composed = { ...base.sections, tools: base.tools.map(toolObject) }
    writeTextFile(composedPath, `${JSON.stringify(composed, null, 2)}\n`)
    return composedPath
  }

  const plannedFiles = result.files.map((planned) => ({
    path: planned.path,
    current: join(out, "to", planned.path),
    base: basePathFor(planned),
    reviewOnly: planned.reviewOnly,
    withRoot: planned.withRoot,
    coldDispatch: planned.coldDispatch,
    batches: planned.batches,
    alsoChangedOnBaseBranch: planned.alsoChangedOnBaseBranch,
  }))

  return { ...result, files: plannedFiles }
}

type PlanArguments = { repo: string; from: string; to: string; since: string | null; sinceFrom: string | null; out: string }

const runPlan = ({ repo, from, to, since, sinceFrom, out }: PlanArguments): string => {
  const commits: PlanCommits = {
    from: resolveCommit(repo, from),
    to: resolveCommit(repo, to),
    since: since ? resolveCommit(repo, since) : null,
    sinceFrom: sinceFrom ? resolveCommit(repo, sinceFrom) : null,
  }

  const files = readChangedFiles(repo, commits)
  const written = writePlan(out, files, planReview(files))
  const mode = commits.since ? "since" : "full"

  return toJson({ mode, ...commits, out, ...written })
}

const readArguments = (argv: string[]) => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        current: { type: "string" },
        base: { type: "string" },
        names: { type: "boolean", default: false },
        variants: { type: "string", multiple: true },
        show: { type: "string", multiple: true },
        plan: { type: "boolean", default: false },
        repo: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        since: { type: "string" },
        "since-from": { type: "string" },
        out: { type: "string" },
      },
    })

    return values
  } catch (error) {
    throw new InputError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
}

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

const run = (argv: string[]): string => {
  const values = readArguments(argv)
  const { current: currentPath, base: basePath, names, variants = [], show = [], plan } = values
  const { repo, from, to, since, out } = values
  const sinceFrom = values["since-from"]
  const planOptionGiven = [repo, from, to, since, sinceFrom, out].some(Boolean)

  if (plan) {
    if (currentPath || basePath || names || variants.length > 0 || show.length > 0) {
      throw new InputError("--plan reads the files from git; it cannot be combined with --current, --base, --names, --variants, or --show")
    }

    if (!repo || !from || !to || !out) {
      throw new InputError(`--plan needs --repo, --from, --to, and --out\n${USAGE}`)
    }

    if (Boolean(since) !== Boolean(sinceFrom)) {
      throw new InputError("--since and --since-from go together: the last review's commit and the merge base it used")
    }

    return runPlan({ repo, from, to, since: since ?? null, sinceFrom: sinceFrom ?? null, out })
  }

  if (planOptionGiven) {
    throw new InputError(`--repo, --from, --to, --since, --since-from, and --out belong to --plan\n${USAGE}`)
  }

  if (!currentPath) {
    throw new InputError(USAGE)
  }

  const current = loadSurface(currentPath)

  if (show.length > 0) {
    if (basePath || names || variants.length > 0) {
      throw new InputError("--show prints tools from --current; it cannot be combined with --base, --names, or --variants")
    }

    return showTools(current, show, currentPath)
  }

  if (variants.length > 0) {
    if (basePath || names) {
      throw new InputError("--variants lists other configurations; it cannot be combined with --base or --names")
    }

    const loadedVariants = variants.map((file) => ({ file, surface: loadSurface(file) }))
    return toJson({ current: currentPath, variants: listVariants(current, loadedVariants) })
  }

  const base = basePath ? loadSurface(basePath) : null
  const report = compareSurfaces(base, current, { base: basePath ?? null, current: currentPath })

  if (!names) {
    return toJson(report)
  }

  const { changed, added, removed, unchanged, orderOnly, inScope } = report
  return toJson({ changed, added, removed, unchanged, orderOnly, inScope })
}

const main = () => {
  try {
    console.log(run(process.argv.slice(2)))
  } catch (error) {
    if (!(error instanceof InputError)) throw error

    console.error(error.message)
    process.exitCode = 2
  }
}

// The plugin cache reaches this file through a symlink, so the two paths are compared after resolving links.
const invokedPath = process.argv[1]

if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
