#!/usr/bin/env bun
// Regenerates the function-growth fixtures: real ESLint messages and the spans extractFunctionSpans returns,
// cut down to the named functions each case selects and the functions around them. Run it with
// FUNCTION_GROWTH_TOOLING_REPO set to a vault-cortex checkout, which supplies both the commits and ESLint.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type FunctionSpan,
  type LintMessage,
  createLinter,
  extractFunctionSpans,
  loadTooling,
  measureFunctions,
  nameFunctions,
} from "../../../function-growth.ts"

/** One copy of a file: a commit and path in the tooling repo, or an inline source linted at `path`. */
type CopySpec = { commit: string; path: string; selected: readonly string[] } | { source: string; path: string; selected: readonly string[] }
type CaseSpec = { file: string; description: string; lintPath: string; base?: CopySpec; head: CopySpec }

const PR_HEAD = "771fa61fcb87deb8f70e82d7b76a813ca39ef415"

// vault-cortex has no getter, class field or static block, so those forms are linted from this source.
const CLASS_MEMBERS_SOURCE = `export class Cache {
  size = 0
  label = this.size > 1 ? "many" : "few"
  static {
    if (process.env.DEBUG) console.log("debug")
  }
  get count(): number {
    return this.size || 1
  }
  apply = (value: number): number => value && 1
}

const handlers: Record<string, unknown> = {}
handlers.reset = () => 0

export default function (): number {
  return 1
}
`

const CASES: readonly CaseSpec[] = [
  {
    file: "method.json",
    description: "A class method and an object-literal method, each with its parameters on their own lines",
    lintPath: "src/vault-mcp/oauth/oauth-provider.ts",
    head: { commit: PR_HEAD, path: "src/vault-mcp/oauth/oauth-provider.ts", selected: ["SqliteClientsStore.registerClient", "provider.authorize"] },
  },
  {
    file: "property-arrow.json",
    description: "Arrow functions as object-literal property values, with a repeated key numbered",
    lintPath: "src/vault-mcp/obsidian-markdown/tasks.ts",
    head: {
      commit: PR_HEAD,
      path: "src/vault-mcp/obsidian-markdown/tasks.ts",
      selected: ["ROUND_TRIP_FIELDS.readParsed", "ROUND_TRIP_FIELDS.readSubmitted", "ROUND_TRIP_FIELDS.readParsed #2"],
    },
  },
  {
    file: "two-line-arrow-head.json",
    description: "An exported arrow function whose parameters span lines, so its `=>` sits below its start",
    lintPath: "cli/src/adapters/docker.ts",
    head: { commit: PR_HEAD, path: "cli/src/adapters/docker.ts", selected: ["probeHealth"] },
  },
  {
    file: "callback.json",
    description: "An anonymous callback passed to `map` inside a named function",
    lintPath: "cli/src/adapters/docker.ts",
    head: { commit: PR_HEAD, path: "cli/src/adapters/docker.ts", selected: ["instanceVolumeNames › callback (map)"] },
  },
  {
    file: "iife.json",
    description: "An async arrow called where it is written, as one branch of a conditional initializer",
    lintPath: "src/vault-mcp/search/search-index.ts",
    head: { commit: PR_HEAD, path: "src/vault-mcp/search/search-index.ts", selected: ["rebuildFromVault › IIFE"] },
  },
  {
    file: "wrapped-callback.json",
    description: "A callback passed to an awaited call that initializes a variable, so it takes the variable's name",
    lintPath: "src/vault-mcp/vault-operations/trash-sweeper.ts",
    head: { commit: PR_HEAD, path: "src/vault-mcp/vault-operations/trash-sweeper.ts", selected: ["rowOutcome"] },
  },
  {
    file: "lock-callback.json",
    description: "The update lock callback before and after a change that raised its complexity from 47 to 53",
    lintPath: "src/vault-mcp/vault-operations/task-mutations.ts",
    base: { commit: "01f12de7^", path: "src/vault-mcp/vault-operations/task-mutations.ts", selected: ["updateTask › callback (withExclusiveFileLock)"] },
    head: { commit: "01f12de7", path: "src/vault-mcp/vault-operations/task-mutations.ts", selected: ["updateTask › callback (withExclusiveFileLock)"] },
  },
  {
    file: "rename.json",
    description: "A function in a file the change moved to a new folder, both copies linted at the new path",
    lintPath: "cli/src/commands/init.ts",
    base: { commit: "6ce758b6^", path: "cli/src/init.ts", selected: ["runLocalInit"] },
    head: { commit: "6ce758b6", path: "cli/src/commands/init.ts", selected: ["runLocalInit"] },
  },
  {
    file: "class-members.json",
    description: "Class fields, a static block, a getter, a field arrow, an assignment and a default export",
    lintPath: "src/class-members.ts",
    head: {
      source: CLASS_MEMBERS_SOURCE,
      path: "src/class-members.ts",
      selected: [
        "Cache.size initializer",
        "Cache.label initializer",
        "Cache static block",
        "Cache.count",
        "Cache.apply initializer",
        "Cache.apply",
        "handlers.reset",
        "default",
      ],
    },
  },
]

const toolingRepo = process.env.FUNCTION_GROWTH_TOOLING_REPO
if (!toolingRepo) throw new Error("set FUNCTION_GROWTH_TOOLING_REPO to a vault-cortex checkout")

const tooling = await loadTooling(toolingRepo)
if (!tooling) throw new Error(`no ESLint in ${toolingRepo}`)
const lint = createLinter(tooling, toolingRepo, "classic")

const gitIn = (args: readonly string[]): string => {
  return execFileSync("git", ["-C", toolingRepo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
}

/** The spans to keep: the selected ones and every function around them, which their names are built from. */
const keptIndexes = (spans: readonly FunctionSpan[], selected: readonly number[]): number[] => {
  const kept = new Set<number>()
  for (const index of selected) {
    // The walk moves out one enclosing function per pass until the top level or a span already kept.
    let current: number | null = index
    while (current !== null && !kept.has(current)) {
      kept.add(current)
      current = spans[current]?.enclosing ?? null
    }
  }
  return [...kept].toSorted((first, second) => first - second)
}

const recordCopy = async (spec: CopySpec, lintPath: string): Promise<Record<string, unknown>> => {
  const code = "source" in spec ? spec.source : gitIn(["show", `${spec.commit}:${spec.path}`])
  const { messages, tree } = await lint(code, join(toolingRepo, lintPath))
  if (!tree) throw new Error(`${spec.path}: ESLint returned no syntax tree`)

  const spans = extractFunctionSpans(tree.ast, tree.text)
  const named = nameFunctions(spans)
  const selected = spec.selected.map((name) => {
    const index = named.findIndex((entry) => entry.name === name)
    if (index === -1) throw new Error(`${spec.path}: no function named ${name}; names: ${named.map((entry) => entry.name).join(", ")}`)
    return index
  })
  const kept = keptIndexes(spans, selected)
  const keptNames = new Set(kept.map((index) => named[index]?.name))
  const newIndex = new Map(kept.map((oldIndex, position) => [oldIndex, position]))
  const keptSpans = kept.flatMap((index) => {
    const span = spans[index]
    if (!span) return []
    return [{ ...span, enclosing: span.enclosing === null ? null : (newIndex.get(span.enclosing) ?? null) }]
  })
  const complexityMessages = messages.filter((message) => message.ruleId === "complexity")
  const measured = measureFunctions(complexityMessages, spans)
  const keptMessages: LintMessage[] = complexityMessages
    .filter((_, index) => keptNames.has(measured[index]?.name))
    .map(({ ruleId, message, line, column, endLine, endColumn }) => ({ ruleId, message, line, column, endLine, endColumn }))

  // The cut-down spans must name each kept message as the whole file does, or the fixture would test other names.
  const fullNames = measured.map((entry) => entry.name).filter((name) => keptNames.has(name))
  const subsetNames = measureFunctions(keptMessages, keptSpans).map((entry) => entry.name)
  if (JSON.stringify(fullNames) !== JSON.stringify(subsetNames)) {
    throw new Error(`${spec.path}: the kept spans name the messages ${JSON.stringify(subsetNames)}, the file ${JSON.stringify(fullNames)}`)
  }

  const origin = "source" in spec ? { source: spec.source } : { commit: gitIn(["rev-parse", spec.commit]).trim() }
  return { ...origin, path: spec.path, selected: spec.selected, messages: keptMessages, spans: keptSpans }
}

const folder = fileURLToPath(new URL(".", import.meta.url))
for (const spec of CASES) {
  const base = spec.base ? { base: await recordCopy(spec.base, spec.lintPath) } : {}
  const fixture = { description: spec.description, lintPath: spec.lintPath, ...base, head: await recordCopy(spec.head, spec.lintPath) }
  writeFileSync(join(folder, spec.file), `${JSON.stringify(fixture, null, 2)}\n`)
  process.stdout.write(`wrote ${spec.file}\n`)
}
