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

/** Any non-null object, such as a thrown error, whose own fields can then be read. */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null
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

const byCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Sorts object keys at every depth, so schemas that differ only in key order serialise alike. Array order is kept, because it is part of a schema's meaning. */
const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (!isJsonObject(value)) {
    return value
  }

  const sortedEntries = Object.entries(value).toSorted(([leftKey], [rightKey]) => byCodeUnit(leftKey, rightKey))
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

/** The texts that have more copies in `copies` than in `otherCopies`. */
const textsWithMoreCopies = (copies: Map<string, number>, otherCopies: Map<string, number>): string[] => {
  return [...copies.keys()].filter((text) => (copies.get(text) ?? 0) > (otherCopies.get(text) ?? 0))
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
    // Each overlap is trimmed before it is compared with the base:
    // - a lone half of a two-unit character at an edge is dropped, since overlaps are cut by code unit;
    // - the spaces at its edges are dropped, so it still matches the base's repetition when the change
    //   only added a space beside it.
    // Trimming can shorten an overlap below the threshold, so the threshold is checked again.
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

/**
 * One file as a `--since` plan reads it at its two extra commits: `since` (the head the last review saw) and
 * `sinceFrom` (the merge base that review used). `path` is the file's path at `since`; `sinceFrom` is read at the
 * path the file had at that merge base, which differs when the branch renamed the file before the review.
 */
export type SinceSides = { path: string; since: FileSide; sinceFrom: FileSide }

/** One changed `.json` path. `path` is its path at `--to`; `fromPath` differs only when the file was renamed. */
export type ChangedFile = {
  path: string
  fromPath: string
  from: FileSide
  to: FileSide
  sinceSides: SinceSides | null
}

/** One tool to review. `key`, `edit`, and `definition` are JSON strings, so equal values mean equal content. */
type ReviewRecord = {
  name: string
  // The tool's name with its whole definition before and after. Records with equal keys are one review.
  key: string
  // What the change did to the tool, without the wording it left alone (see editKey). Equal edits are traced once.
  edit: string
  // The tool's whole definition at `--to`, which dropToolsShippedElsewhere looks for in other files.
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
  // The tools this file's dispatches review: the records assigned to it.
  reviewOnly: string[]
  // True when one of those records is the first of its edit, so the dispatches get the repository root and the
  // reviewer traces each tool's failures in the source.
  withRoot: boolean
  // True when `reviewOnly` holds more than TOOLS_PER_DISPATCH tools. The cold read (the reviewer's first read,
  // without the base) then goes out as one dispatch over all of them, and the diff read as one dispatch per batch.
  coldDispatch: boolean
  // `reviewOnly` in runs of at most TOOLS_PER_DISPATCH.
  batches: string[][]
  alsoChangedOnBaseBranch: string[]
  // Null when the file has nothing to compare with: a new tool-list file, or in `--since` mode a file that was not a
  // tool list at the review.
  base: ReviewBase | null
}

export type PlanResult = {
  // How many records the planned files review in total.
  records: number
  files: PlannedFile[]
  // Changed tool lists with no tool to review, which happens when
  // - only a file's instructions, prompts, or key order changed;
  // - a new file ships only definitions another changed file already has;
  // - in `--since` mode, a file's tools changed since the review only through the base branch.
  filesWithNoToolChange: string[]
  broken: { path: string; reason: string }[]
  // Whole tool-list files that are gone, with the tools they held.
  removed: { path: string; tools: string[] }[]
  // Tools gone from a file that is still a tool list.
  removedTools: { path: string; tools: string[] }[]
  addedThenDropped: { path: string; tools: string[] }[]
  notToolLists: string[]
}

// The MCP specification's order for a tool's parts. Every comparison sorts keys, so only the composed base file that
// writePlan writes shows this order.
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

/**
 * Every node of a JSON value by its path. Containers get an entry too, so adding an empty object or array is a change.
 * A container's entry is the marker "[]" or "{}", which no leaf can equal, because a leaf is JSON-encoded.
 */
const nodesByPath = (value: JsonValue, path = ""): [string, string][] => {
  if (Array.isArray(value)) {
    return [[path, "[]"], ...value.flatMap((child, index) => nodesByPath(child, `${path}/${index}`))]
  }

  if (isJsonObject(value)) {
    return [[path, "{}"], ...Object.entries(value).flatMap(([key, child]) => nodesByPath(child, `${path}/${key}`))]
  }

  return [[path, JSON.stringify(value)]]
}

/**
 * The nodes of a tool's definition whose values changed, as sorted path, before, after triples. Every part counts
 * (title, schemas, annotations) except string `description` values, which descriptionLines and schemaSentences cover.
 */
const changedDefinitionNodes = (base: Tool, current: Tool): [string, string | null, string | null][] => {
  const nodesWithoutDescriptions = (tool: Tool): Map<string, string> => {
    return new Map(nodesByPath(withoutDescriptionText(toolObject(tool))))
  }

  const before = nodesWithoutDescriptions(base)
  const after = nodesWithoutDescriptions(current)
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted(byCodeUnit)

  return paths
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => [path, before.get(path) ?? null, after.get(path) ?? null])
}

/** What a change did to one tool, independent of the wording it did not touch. An added tool's edit is its whole definition. */
const editKey = (base: Tool | undefined, current: Tool): string => {
  if (!base) return JSON.stringify([current.name, "added", toolKey(current)])

  const lines = textChange(descriptionLines(base), descriptionLines(current))
  const sentences = textChange(schemaSentences(base), schemaSentences(current))

  // Sorted, so the same lines added or removed in a different order give the same key.
  return JSON.stringify([
    current.name,
    lines.added.toSorted(byCodeUnit),
    lines.removed.toSorted(byCodeUnit),
    sentences.added.toSorted(byCodeUnit),
    sentences.removed.toSorted(byCodeUnit),
    changedDefinitionNodes(base, current),
  ])
}

const recordFor = ({
  base,
  current,
  alsoChangedOnBaseBranch,
}: {
  base: Tool | undefined
  current: Tool
  alsoChangedOnBaseBranch: boolean
}): ReviewRecord => {
  return {
    name: current.name,
    key: JSON.stringify([current.name, toolKey(base), toolKey(current)]),
    edit: editKey(base, current),
    definition: toolKey(current),
    alsoChangedOnBaseBranch,
  }
}

const fileReview = ({
  path,
  base,
  records,
  current,
}: {
  path: string
  base: ReviewBase | null
  records: ReviewRecord[]
  current: Surface
}): FileReview => {
  return { path, base, records, shippedDefinitions: new Set(current.tools.map(toolKey)) }
}

const sideToolsByName = (side: FileSide): Map<string, Tool> => {
  return side.kind === "toolList" ? new Map(side.surface.tools.map((tool) => [tool.name, tool])) : new Map()
}

/**
 * Whether two sides hold the same content. Tool lists compare by their sections and their tools, tool order included.
 * Two sides that are not tool lists are the same when their kinds match, whatever made either one not a tool list.
 */
const sameSide = (left: FileSide, right: FileSide): boolean => {
  if (left.kind !== "toolList" || right.kind !== "toolList") return left.kind === right.kind

  const leftKey = canonicalJson({ ...left.surface.sections, tools: left.surface.tools.map(toolObject) })
  const rightKey = canonicalJson({ ...right.surface.sections, tools: right.surface.tools.map(toolObject) })
  return leftKey === rightKey
}

type SinceDecision = { inScope: false } | { inScope: true; base: Tool | undefined; alsoChangedOnBaseBranch: boolean }

/**
 * Whether a tool needs review since the last one, and what to compare it with. The four definitions are the tool at
 * `sinceFrom` (the merge base the last review used), `since` (the head that review saw), `from` (the current merge
 * base), and `to` (the current head). The first matching rule applies:
 * 1. The branch never touched it (`since` equals `sinceFrom`, and `to` equals `from`): no.
 * 2. `to` differs from `since`, and `since` equals `sinceFrom` (first touched after the review): yes, against `from`.
 * 3. `to` differs from `since`, and the branch touched it before the review: yes, against `since`.
 * 4. `to` equals `since`, but the base branch changed it (`sinceFrom` differs from `from`) and a merge kept the
 *    branch's text (`to` differs from `from`): yes, against `from`.
 * 5. Otherwise: no.
 * `alsoChangedOnBaseBranch` is true whenever `sinceFrom` differs from `from`.
 */
export const decideSince = (definitions: {
  since: Tool | undefined
  sinceFrom: Tool | undefined
  from: Tool | undefined
  to: Tool | undefined
}): SinceDecision => {
  const { since, sinceFrom, from, to } = definitions
  const alsoChangedOnBaseBranch = !sameTool(sinceFrom, from)

  if (sameTool(since, sinceFrom) && sameTool(to, from)) return { inScope: false }

  if (!sameTool(to, since)) {
    const firstTouchedAfterReview = sameTool(since, sinceFrom)
    return { inScope: true, base: firstTouchedAfterReview ? from : since, alsoChangedOnBaseBranch }
  }

  if (alsoChangedOnBaseBranch && !sameTool(to, from)) return { inScope: true, base: from, alsoChangedOnBaseBranch }

  return { inScope: false }
}

type Classified =
  | { kind: "review"; review: FileReview; removedTools: string[]; addedThenDropped: string[] }
  | { kind: "broken"; reason: string }
  | { kind: "removed"; tools: string[] }
  | { kind: "addedThenDropped"; tools: string[] }
  // A file the base branch deleted and the branch never touched. planReview lists it nowhere.
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

  // A `--from` side that is absent or not a tool list gives no base, so the file is reviewed as a new tool list.
  const base = from.kind === "toolList" ? from.surface : null

  // compareSurfaces applies the reviewer's own scope rule; only its `inScope` and `removed` lists are used here.
  const report = compareSurfaces(base, to.surface, { base: file.fromPath, current: file.path })
  const baseTools = sideToolsByName(from)

  const records = to.surface.tools
    .filter((tool) => report.inScope.includes(tool.name))
    .map((tool) => recordFor({ base: baseTools.get(tool.name), current: tool, alsoChangedOnBaseBranch: false }))

  const reviewBase: ReviewBase | null = base ? { kind: "fromCopy", path: file.fromPath } : null
  const review = fileReview({ path: file.path, base: reviewBase, records, current: to.surface })
  return { kind: "review", review, removedTools: report.removed, addedThenDropped: [] }
}

/**
 * The composed `--since` base: each in-scope tool's chosen base, and the `--to` version of every other tool and of the
 * sections. An in-scope tool with no base (one added since) is left out, so the reviewer sees it as added.
 */
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

  // A file absent at the review takes the new merge base's side (`from`) for both review-time sides, so decideSince
  // compares each of its tools with `from` (rule 2), or leaves it out when it still equals `from` (rule 1).
  const sinceAbsent = sinceSides.since.kind === "absent"
  const since = sinceAbsent ? from : sinceSides.since
  const sinceFrom = sinceAbsent ? from : sinceSides.sinceFrom

  if (to.kind === "notToolList") {
    return since.kind === "toolList" ? { kind: "broken", reason: to.reason } : { kind: "notToolList" }
  }

  if (to.kind === "absent") {
    // Not a tool list at the review, so no reviewed tool is lost.
    if (since.kind !== "toolList") return { kind: "notToolList" }

    // The branch had not changed it by the review, and the new merge base lacks it, so the base branch deleted it.
    if (sameSide(since, sinceFrom) && from.kind === "absent") return { kind: "excluded" }

    // Neither merge base has it, so the branch added it and has deleted it again.
    if (sinceFrom.kind === "absent" && from.kind === "absent") return { kind: "addedThenDropped", tools: toolNames(since) }

    // Otherwise a tool list the review saw is gone.
    return { kind: "removed", tools: toolNames(since) }
  }

  const sinceTools = sideToolsByName(since)
  const sinceFromTools = sideToolsByName(sinceFrom)
  const fromTools = sideToolsByName(from)
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
    records.push(recordFor({ base: decision.base, current: tool, alsoChangedOnBaseBranch: decision.alsoChangedOnBaseBranch }))
  }

  const currentNames = new Set(to.surface.tools.map((tool) => tool.name))
  const goneSinceReview = [...sinceTools.values()].filter((tool) => !currentNames.has(tool.name))

  // The same two rules as for a deleted file above, applied to one tool.
  const baseBranchRemoval = (tool: Tool): boolean => sameTool(tool, sinceFromTools.get(tool.name)) && !fromTools.has(tool.name)
  const branchAddedThenDropped = (tool: Tool): boolean => !sinceFromTools.has(tool.name) && !fromTools.has(tool.name)

  const reported = goneSinceReview.filter((tool) => !baseBranchRemoval(tool))
  const addedThenDropped = reported.filter(branchAddedThenDropped).map((tool) => tool.name)
  const removedTools = reported.filter((tool) => !branchAddedThenDropped(tool)).map((tool) => tool.name)

  // A file that was not a tool list at the review has no base, so its tools are reviewed as new, and
  // dropToolsShippedElsewhere treats it as a new file.
  const reviewBase: ReviewBase | null =
    since.kind === "toolList" ? { kind: "composed", path: file.path, ...composeSinceBase(to.surface, bases) } : null
  const review = fileReview({ path: file.path, base: reviewBase, records, current: to.surface })
  return { kind: "review", review, removedTools, addedThenDropped }
}

const chunk = (names: readonly string[], size: number): string[][] => {
  return Array.from({ length: Math.ceil(names.length / size) }, (_, index) => names.slice(index * size, (index + 1) * size))
}

/**
 * Drops a tool from a file with no base when a changed file that has a base already ships the same definition: that
 * text is unchanged there or reviewed there. Unchanged files are not read, so a tool copied from an unchanged file
 * into a file with no base is still reviewed.
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

/** A path with its tools, or nothing when it has none, for the plan's per-file tool lists. */
const pathWithTools = (path: string, tools: string[]): { path: string; tools: string[] }[] => {
  return tools.length > 0 ? [{ path, tools }] : []
}

/**
 * Turns the changed files into the reviewer's dispatches.
 * - One record per distinct tool definition before and after; equal records across files are reviewed once.
 * - Files are ordered by how many distinct records they hold, most first, then by path in code-unit order.
 * - A file that holds the first record of some edit gets the repository root, so the reviewer traces that edit's
 *   failures in the source. Each distinct edit is traced once.
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

  const filesWithNoToolChange = reviewResults.filter(({ path, removedTools, addedThenDropped }) => {
    return (eligibleCounts.get(path) ?? 0) === 0 && removedTools.length === 0 && addedThenDropped.length === 0
  })

  const removedTools = reviewResults.flatMap(({ path, removedTools: tools }) => pathWithTools(path, tools))
  const droppedTools = reviewResults.flatMap(({ path, addedThenDropped: tools }) => pathWithTools(path, tools))
  const droppedFiles = classified.flatMap(({ path, result }) => (result.kind === "addedThenDropped" ? [{ path, tools: result.tools }] : []))

  return {
    records: planned.reduce((sum, file) => sum + file.reviewOnly.length, 0),
    files: planned,
    filesWithNoToolChange: filesWithNoToolChange.map(({ path }) => path),
    broken: classified.flatMap(({ path, result }) => (result.kind === "broken" ? [{ path, reason: result.reason }] : [])),
    removed: classified.flatMap(({ path, result }) => (result.kind === "removed" ? [{ path, tools: result.tools }] : [])),
    removedTools,
    // Whole files and single tools share this list because the dispatcher only lists them. Removals stay in two lists,
    // because a removed file is always a finding, and a removed tool is one only when the change does not mention it.
    addedThenDropped: [...droppedFiles, ...droppedTools],
    notToolLists: classified.filter(({ result }) => result.kind === "notToolList").map(({ path }) => path),
  }
}

/** Git's own message when it printed one, since execFileSync's error message only says the command failed. */
const gitErrorText = (error: unknown): string => {
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr.trim()) {
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

/**
 * The full SHA of the commit `ref` names. It calls git directly rather than through runGit, because `--quiet` makes
 * git print nothing for a ref that is not a commit; this function supplies the "not a commit" message, which the
 * ship-check re-review matches on.
 */
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

/** The `.json` paths that changed from one commit to another, in every folder, since git's `*` in a pathspec crosses `/`. */
const listChangedJson = (repo: string, range: { from: string; to: string }): PathChange[] => {
  return parseNameStatus(runGit(repo, ["diff", ...DIFF_OUTPUT_OPTIONS, range.from, range.to, "--", "*.json"]))
}

type FileAtCommit = { commit: string; path: string }

const pathExists = (repo: string, { commit, path }: FileAtCommit): boolean => {
  return runGit(repo, ["ls-tree", "-z", "--name-only", commit, "--", path]) !== ""
}

/**
 * Unlike parseJson, this returns null for text that fails to parse, which readSide records as a side that is not a
 * tool list rather than an input error. A parsed value is wrapped, so a file holding `null` still reads as parsed.
 */
const parseJsonText = (text: string): { parsed: unknown } | null => {
  try {
    return { parsed: JSON.parse(text) }
  } catch {
    return null
  }
}

const readSide = (repo: string, { commit, path }: FileAtCommit): FileSide => {
  if (!pathExists(repo, { commit, path })) return { kind: "absent" }

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

/**
 * The commits a plan compares, named after their options:
 * - `from`: the commit the change starts from, the current merge base with the base branch.
 * - `to`: the head under review.
 * - `since`: the head the last tool review saw (`--since` mode only).
 * - `sinceFrom`: the merge base that review used (`--since` mode only).
 */
type PlanCommits = { from: string; to: string; since: string | null; sinceFrom: string | null }

/** Reads every changed `.json` path at each commit the plan compares. */
const readChangedFiles = (repo: string, commits: PlanCommits): ChangedFile[] => {
  const { from, to, since, sinceFrom } = commits
  const fromChanges = listChangedJson(repo, { from, to })
  const fromPathByToPath = new Map(fromChanges.map((change) => [change.path, change.oldPath]))

  if (!since || !sinceFrom) {
    return fromChanges.map((change) => ({
      path: change.path,
      fromPath: change.oldPath,
      from: readSide(repo, { commit: from, path: change.oldPath }),
      to: readSide(repo, { commit: to, path: change.path }),
      sinceSides: null,
    }))
  }

  const sinceChanges = listChangedJson(repo, { from: since, to })
  const sincePathByToPath = new Map(sinceChanges.map((change) => [change.path, change.oldPath]))

  // A file the branch renamed before the review still has its old name at the review's merge base.
  const sinceFromChanges = listChangedJson(repo, { from: sinceFrom, to: since })
  const sinceFromPathBySincePath = new Map(sinceFromChanges.map((change) => [change.path, change.oldPath]))

  // When the merge base moved, a path the base branch changed is checked too, because a merge may have kept the
  // branch's text over the base branch's edit. Git names each such path as it is at `--from`; toPathByFromPath turns
  // it into the `--to` name the other lists use, so a file the branch renamed is read once, under its `--to` name.
  const toPathByFromPath = new Map(fromChanges.map((change) => [change.oldPath, change.path]))
  const baseBranchPaths = sinceFrom === from ? [] : listChangedJson(repo, { from: sinceFrom, to: from }).map((change) => change.path)
  const changedPaths = [...sinceChanges.map((change) => change.path), ...baseBranchPaths.map((path) => toPathByFromPath.get(path) ?? path)]
  const paths = [...new Set(changedPaths)].toSorted(byCodeUnit)

  return paths.map((path) => {
    const fromPath = fromPathByToPath.get(path) ?? path
    const sincePath = sincePathByToPath.get(path) ?? path
    const sinceFromPath = sinceFromPathBySincePath.get(sincePath) ?? sincePath

    return {
      path,
      fromPath,
      from: readSide(repo, { commit: from, path: fromPath }),
      to: readSide(repo, { commit: to, path }),
      sinceSides: {
        path: sincePath,
        since: readSide(repo, { commit: since, path: sincePath }),
        sinceFrom: readSide(repo, { commit: sinceFrom, path: sinceFromPath }),
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
    const code = isRecord(error) ? error.code : undefined

    if (code === "EEXIST") throw new InputError(`${out}: already exists; --out must name a new folder`)
    if (code === "ENOENT") throw new InputError(`${out}: its parent folder does not exist`)
    throw error
  }
}

/** A planned file as the printed plan gives it, with `current` and `base` as paths of files written under `--out`. */
type PrintedFile = Omit<PlannedFile, "base"> & { current: string; base: string | null }

type PrintedPlan = Omit<PlanResult, "files"> & { files: PrintedFile[] }

/**
 * Writes the plan's files under `out` and returns the plan with their paths. It copies each tool list it read at
 * `--from` and `--to` to `from/` and `to/`, and writes each composed `--since` base to `since-base/`. The printed
 * plan names the `to/` copy and the base.
 */
const writePlan = (out: string, files: readonly ChangedFile[], result: PlanResult): PrintedPlan => {
  createOutputFolder(out)

  for (const file of files) {
    if (file.from.kind === "toolList") writeTextFile(join(out, "from", file.fromPath), file.from.text)
    if (file.to.kind === "toolList") writeTextFile(join(out, "to", file.path), file.to.text)
  }

  const basePath = (base: ReviewBase): string => {
    if (base.kind === "fromCopy") return join(out, "from", base.path)
    return join(out, "since-base", base.path)
  }

  for (const { base } of result.files) {
    if (base?.kind !== "composed") continue

    const composed = { ...base.sections, tools: base.tools.map(toolObject) }
    writeTextFile(basePath(base), `${JSON.stringify(composed, null, 2)}\n`)
  }

  const printedFiles = result.files.map((planned) => ({
    path: planned.path,
    current: join(out, "to", planned.path),
    base: planned.base ? basePath(planned.base) : null,
    reviewOnly: planned.reviewOnly,
    withRoot: planned.withRoot,
    coldDispatch: planned.coldDispatch,
    batches: planned.batches,
    alsoChangedOnBaseBranch: planned.alsoChangedOnBaseBranch,
  }))

  return { ...result, files: printedFiles }
}

type PlanArguments = { repo: string; from: string; to: string; since: string | null; sinceFrom: string | null; out: string }

const runPlan = ({ repo, from, to, since, sinceFrom, out }: PlanArguments): string => {
  const commits: PlanCommits = {
    from: resolveCommit(repo, from),
    to: resolveCommit(repo, to),
    since: since ? resolveCommit(repo, since) : null,
    sinceFrom: sinceFrom ? resolveCommit(repo, sinceFrom) : null,
  }

  // Run inside a folder of the work tree, git lists only that folder's changes and looks each listed path up from
  // that folder, so the plan would miss some files and read the rest as absent. Every call runs at the top instead.
  const root = runGit(repo, ["rev-parse", "--show-toplevel"]).trim()
  const files = readChangedFiles(root, commits)
  const printedPlan = writePlan(out, files, planReview(files))
  const mode = commits.since ? "since" : "full"

  return toJson({ mode, ...commits, out, ...printedPlan })
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
