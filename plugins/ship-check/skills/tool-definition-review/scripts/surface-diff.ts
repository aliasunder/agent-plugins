#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs"
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

// Any run of spaces, tabs, or newlines.
const WHITESPACE_RUN = /\s+/g

const USAGE = [
  "Usage: surface-diff.ts --current <file> [--base <file>] [--names]",
  "       surface-diff.ts --current <file> --variants <file> [--variants <file> ...]",
  "       surface-diff.ts --current <file> --show <tool> [--show <tool> ...]",
].join("\n")

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

const textChange = (before: string[], after: string[]): TextChange => {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)

  return {
    added: [...afterSet].filter((text) => !beforeSet.has(text)),
    removed: [...beforeSet].filter((text) => !afterSet.has(text)),
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
    // A trimmed overlap matches the base's repetition even when the change added a space beside it.
    // The threshold is checked again because trimming can shorten an overlap below it.
    const overlaps = commonSubstrings(collapseWhitespace(text), description)
      .map((overlap) => overlap.trim())
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
      throw new InputError(`${label}: no tool named "${name}"`)
    }

    return formatTool(tool)
  })

  return shown.join("\n\n")
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
      },
    })

    return values
  } catch (error) {
    throw new InputError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
}

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

const run = (argv: string[]): string => {
  const { current: currentPath, base: basePath, names, variants = [], show = [] } = readArguments(argv)

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
