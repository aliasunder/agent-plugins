import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

import {
  type FileMeasurement,
  type FunctionSpan,
  type GrowthEntry,
  type LintMessage,
  type MeasuredFunction,
  buildReport,
  createLinter,
  extractFunctionSpans,
  formatLine,
  loadTooling,
  measureFunctions,
  nameFunction,
  nameFunctions,
  pairFunctions,
  parseBudget,
  selectFiles,
} from "../function-growth.ts"

const SCRIPT_PATH = fileURLToPath(new URL("../function-growth.ts", import.meta.url))
const FIXTURES = fileURLToPath(new URL("fixtures/function-growth/", import.meta.url))
const TOOLING_REPO = process.env.FUNCTION_GROWTH_TOOLING_REPO
const NO_TOOLING_REASON = "FUNCTION_GROWTH_TOOLING_REPO is unset, so the tests that need a real ESLint are skipped"
/**
 * The options of each test that lints with a real ESLint: skipped without the tooling repo, and given time to
 * load ESLint's config and parser on the first run.
 */
const NEEDS_TOOLING = { skip: TOOLING_REPO ? false : NO_TOOLING_REASON, timeout: 30_000 }

// Bun's summary counts skipped tests without their reason, so the reason is printed here.
if (!TOOLING_REPO) console.log(NO_TOOLING_REASON)

type FixtureCopy = { commit?: string; source?: string; path: string; selected: string[]; messages: LintMessage[]; spans: FunctionSpan[] }
type Fixture = { description: string; lintPath: string; base?: FixtureCopy; head: FixtureCopy }

const readFixture = (name: string): Fixture => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))

const FIXTURE_NAMES = [
  "callback.json",
  "class-members.json",
  "iife.json",
  "lock-callback.json",
  "method.json",
  "property-arrow.json",
  "rename.json",
  "two-line-arrow-head.json",
  "wrapped-callback.json",
]

const namesOf = (copy: FixtureCopy): string[] => nameFunctions(copy.spans).map((named) => named.name)

const baseOf = (fixture: Fixture): FixtureCopy => {
  if (!fixture.base) throw new Error(`${fixture.description}: the fixture has no base copy`)
  return fixture.base
}

const temporaryRoots: string[] = []
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

const temporaryFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "probe-function-growth-"))
  temporaryRoots.push(folder)
  return folder
}

const runScript = (args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("selectFiles", () => {
  it("keeps changed files with the eight measured extensions", () => {
    const paths = ["a.ts", "b.tsx", "c.mts", "d.cts", "e.js", "f.jsx", "g.mjs", "h.cjs", "README.md", "data.json"]
    const nameStatus = paths.map((path) => `M\0${path}\0`).join("")
    const kept = ["a.ts", "b.tsx", "c.mts", "d.cts", "e.js", "f.jsx", "g.mjs", "h.cjs"]

    assert.deepStrictEqual(selectFiles(nameStatus), kept.map((path) => ({ path, basePath: path })))
  })

  it("leaves out files under __tests__ and *.test.* or *.spec.* files", () => {
    const nameStatus = "M\0src/__tests__/helper.ts\0M\0src/run.test.ts\0M\0src/run.spec.mjs\0M\0src/run.ts\0"

    assert.deepStrictEqual(selectFiles(nameStatus), [{ path: "src/run.ts", basePath: "src/run.ts" }])
  })

  it("reads a renamed file's base copy from its old path and gives an added file none", () => {
    const nameStatus = "R084\0cli/src/docker.ts\0cli/src/adapters/docker.ts\0A\0cli/src/adapters/env-file.ts\0"

    assert.deepStrictEqual(selectFiles(nameStatus), [
      { path: "cli/src/adapters/docker.ts", basePath: "cli/src/docker.ts" },
      { path: "cli/src/adapters/env-file.ts", basePath: null },
    ])
  })

  it("leaves out a file renamed into a test folder", () => {
    assert.deepStrictEqual(selectFiles("R100\0src/helper.ts\0src/__tests__/helper.ts\0"), [])
  })

  it("returns no files for an empty diff", () => {
    assert.deepStrictEqual(selectFiles(""), [])
  })

  it("refuses output that ends inside an entry", () => {
    assert.throws(() => selectFiles("R100\0src/a.ts\0"), new Error('unexpected git diff output: "R100\\u0000src/a.ts\\u0000"'))
  })
})

describe("nameFunctions", () => {
  it("qualifies a class method and an object-literal method by their class and variable", () => {
    assert.deepStrictEqual(namesOf(readFixture("method.json").head), ["SqliteClientsStore.registerClient", "createOAuthProvider", "provider.authorize"])
  })

  it("qualifies property arrows by their variable and numbers a repeated key in source order", () => {
    assert.deepStrictEqual(namesOf(readFixture("property-arrow.json").head), [
      "ROUND_TRIP_FIELDS.readParsed",
      "ROUND_TRIP_FIELDS.readSubmitted",
      "ROUND_TRIP_FIELDS.readParsed #2",
    ])
  })

  it("names an arrow function from the variable it initializes", () => {
    assert.deepStrictEqual(namesOf(readFixture("two-line-arrow-head.json").head), ["probeHealth"])
  })

  it("names an anonymous callback after its enclosing function and its callee", () => {
    assert.deepStrictEqual(namesOf(readFixture("callback.json").head), ["instanceVolumeNames", "instanceVolumeNames › callback (map)"])
  })

  it("names a function called where it is written as an IIFE of its enclosing function", () => {
    assert.deepStrictEqual(namesOf(readFixture("iife.json").head), ["createSearchIndex", "rebuildFromVault", "rebuildFromVault › IIFE"])
  })

  it("names a callback passed to an awaited call after the variable the call initializes", () => {
    assert.deepStrictEqual(namesOf(readFixture("wrapped-callback.json").head), ["sweepExpiredTrashEntries", "rowOutcome"])
  })

  it("names class fields, a static block, a getter, an assignment and a default export", () => {
    assert.deepStrictEqual(namesOf(readFixture("class-members.json").head), [
      "Cache.size initializer",
      "Cache.label initializer",
      "Cache static block",
      "Cache.count",
      "Cache.apply initializer",
      "Cache.apply",
      "handlers.reset",
      "default",
    ])
  })
})

describe("nameFunction", () => {
  const span = (source: FunctionSpan["source"], kind: FunctionSpan["kind"] = "function"): FunctionSpan => ({
    kind,
    start: { line: 1, column: 0 },
    end: { line: 1, column: 10 },
    source,
    enclosing: null,
  })

  it("names a top-level callback <anonymous>", () => {
    assert.equal(nameFunction(span({ kind: "callback", callee: "map" }), null), "<anonymous>")
  })

  it("names a callback that is no call's argument without a callee", () => {
    assert.equal(nameFunction(span({ kind: "callback", callee: null }), "buildProgram"), "buildProgram › callback")
  })

  it("names a top-level IIFE plainly", () => {
    assert.equal(nameFunction(span({ kind: "iife" }), null), "IIFE")
  })

  it("names a static block of an unnamed class without an owner", () => {
    assert.equal(nameFunction(span({ kind: "static-block", owner: null }, "static-block"), null), "static block")
  })

  it("names an unqualified key by the key alone", () => {
    assert.equal(nameFunction(span({ kind: "key", key: "handler", owner: null }), null), "handler")
  })
})

describe("measureFunctions", () => {
  it("assigns a method's message, which ends at the function node's start, to that method", () => {
    assert.deepStrictEqual(measureFunctions(readFixture("method.json").head.messages, readFixture("method.json").head.spans), [
      { name: "SqliteClientsStore.registerClient", enclosing: null, line: 321, complexity: 5 },
      { name: "createOAuthProvider", enclosing: null, line: 388, complexity: 1 },
      { name: "provider.authorize", enclosing: "createOAuthProvider", line: 689, complexity: 2 },
    ])
  })

  it("reports a two-line arrow at the line of its =>, below the line it starts on", () => {
    const { head } = readFixture("two-line-arrow-head.json")

    assert.deepStrictEqual(measureFunctions(head.messages, head.spans), [{ name: "probeHealth", enclosing: null, line: 399, complexity: 3 }])
  })

  it("measures a class field initializer apart from the arrow function it holds", () => {
    const { head } = readFixture("class-members.json")

    assert.deepStrictEqual(measureFunctions(head.messages, head.spans), [
      { name: "Cache.size initializer", enclosing: null, line: 2, complexity: 1 },
      { name: "Cache.label initializer", enclosing: null, line: 3, complexity: 2 },
      { name: "Cache static block", enclosing: null, line: 4, complexity: 2 },
      { name: "Cache.count", enclosing: null, line: 7, complexity: 2 },
      { name: "Cache.apply", enclosing: null, line: 10, complexity: 2 },
      { name: "Cache.apply initializer", enclosing: null, line: 10, complexity: 1 },
      { name: "handlers.reset", enclosing: null, line: 14, complexity: 1 },
      { name: "default", enclosing: null, line: 16, complexity: 1 },
    ])
  })

  it("carries the enclosing function's name for a callback", () => {
    const { head } = readFixture("callback.json")

    assert.deepStrictEqual(measureFunctions(head.messages, head.spans), [
      { name: "instanceVolumeNames", enclosing: null, line: 72, complexity: 1 },
      { name: "instanceVolumeNames › callback (map)", enclosing: "instanceVolumeNames", line: 74, complexity: 1 },
    ])
  })

  it("ignores messages from other rules", () => {
    const { head } = readFixture("two-line-arrow-head.json")
    const otherRule: LintMessage = { ruleId: "max-depth", message: "Blocks are nested too deeply (5).", line: 399, column: 1, endLine: 399, endColumn: 5 }

    assert.deepStrictEqual(measureFunctions([otherRule, ...head.messages], head.spans), [{ name: "probeHealth", enclosing: null, line: 399, complexity: 3 }])
  })

  it("names a message no span contains by its line", () => {
    const { head } = readFixture("two-line-arrow-head.json")
    const outside: LintMessage = { ruleId: "complexity", message: "Function has a complexity of 4. Maximum allowed is 0.", line: 9, column: 1, endLine: 9, endColumn: 9 }

    assert.deepStrictEqual(measureFunctions([outside], head.spans), [{ name: "<unresolved at line 9>", enclosing: null, line: 9, complexity: 4 }])
  })
})

const measuredCopy = (copy: FixtureCopy): MeasuredFunction[] => measureFunctions(copy.messages, copy.spans)

describe("pairFunctions", () => {
  it("pairs the lock callback by name across a change that raised it", () => {
    const fixture = readFixture("lock-callback.json")
    const base = measuredCopy(baseOf(fixture))
    const head = measuredCopy(fixture.head)

    assert.deepStrictEqual(pairFunctions(base, head), {
      pairs: [
        { base: base[0], head: head[0], pairedBy: "name" },
        { base: base[1], head: head[1], pairedBy: "name" },
      ],
      added: [],
    })
  })

  it("pairs a function in a renamed file with its copy at the old path", () => {
    const fixture = readFixture("rename.json")

    assert.deepStrictEqual(pairFunctions(measuredCopy(baseOf(fixture)), measuredCopy(fixture.head)), {
      pairs: [
        {
          base: { name: "runLocalInit", enclosing: null, line: 331, complexity: 31 },
          head: { name: "runLocalInit", enclosing: null, line: 299, complexity: 29 },
          pairedBy: "name",
        },
      ],
      added: [],
    })
  })

  const enclosingFunction: MeasuredFunction = { name: "rebuild", enclosing: null, line: 1, complexity: 3 }
  const mapCallback: MeasuredFunction = { name: "rebuild › callback (map)", enclosing: "rebuild", line: 2, complexity: 2 }
  const flatMapCallback: MeasuredFunction = { name: "rebuild › callback (flatMap)", enclosing: "rebuild", line: 2, complexity: 3 }

  it("pairs a callback whose wrapper changed with the callback that disappeared under the same function", () => {
    assert.deepStrictEqual(pairFunctions([enclosingFunction, mapCallback], [enclosingFunction, flatMapCallback]), {
      pairs: [
        { base: enclosingFunction, head: enclosingFunction, pairedBy: "name" },
        { base: mapCallback, head: flatMapCallback, pairedBy: "enclosing" },
      ],
      added: [],
    })
  })

  it("pairs same-named callbacks by equal complexity when a sibling was inserted before them", () => {
    const complexCallback: MeasuredFunction = { name: "rebuild › callback (forEach)", enclosing: "rebuild", line: 3, complexity: 4 }
    const insertedTrivial: MeasuredFunction = { name: "rebuild › callback (forEach)", enclosing: "rebuild", line: 2, complexity: 1 }
    const renumbered: MeasuredFunction = { ...complexCallback, name: "rebuild › callback (forEach) #2", line: 6 }

    assert.deepStrictEqual(pairFunctions([enclosingFunction, complexCallback], [enclosingFunction, insertedTrivial, renumbered]), {
      pairs: [
        { base: enclosingFunction, head: enclosingFunction, pairedBy: "name" },
        { base: complexCallback, head: renumbered, pairedBy: "name" },
      ],
      added: [insertedTrivial],
    })
  })

  it("never pairs a named nested function with a disappeared callback", () => {
    const namedNested: MeasuredFunction = { name: "keepAlive", enclosing: "rebuild", line: 2, complexity: 2 }

    assert.deepStrictEqual(pairFunctions([enclosingFunction, mapCallback], [enclosingFunction, namedNested]), {
      pairs: [{ base: enclosingFunction, head: enclosingFunction, pairedBy: "name" }],
      added: [namedNested],
    })
  })

  it("pairs each disappeared base function with one head function at most", () => {
    const secondCallback: MeasuredFunction = { name: "rebuild › callback (filter)", enclosing: "rebuild", line: 3, complexity: 1 }

    assert.deepStrictEqual(pairFunctions([mapCallback], [flatMapCallback, secondCallback]), {
      pairs: [{ base: mapCallback, head: flatMapCallback, pairedBy: "enclosing" }],
      added: [secondCallback],
    })
  })

  it("treats a head function as new when nothing disappeared under its enclosing function", () => {
    assert.deepStrictEqual(pairFunctions([enclosingFunction, mapCallback], [enclosingFunction, mapCallback, flatMapCallback]), {
      pairs: [
        { base: enclosingFunction, head: enclosingFunction, pairedBy: "name" },
        { base: mapCallback, head: mapCallback, pairedBy: "name" },
      ],
      added: [flatMapCallback],
    })
  })

  it("never pairs top-level functions by enclosing function", () => {
    const renamed: MeasuredFunction = { name: "refresh", enclosing: null, line: 1, complexity: 3 }

    assert.deepStrictEqual(pairFunctions([enclosingFunction], [renamed]), { pairs: [], added: [renamed] })
  })
})

describe("parseBudget", () => {
  const cases = [
    { label: "no rule as ESLint's default", rule: undefined, expected: { max: 20, source: "default", variant: "classic" } },
    { label: "severity 0 as ESLint's default", rule: [0, { max: 5 }], expected: { max: 20, source: "default", variant: "classic" } },
    { label: "an `off` string as ESLint's default", rule: "off", expected: { max: 20, source: "default", variant: "classic" } },
    { label: "severity 1 with `max` as warned", rule: [1, { max: 15 }], expected: { max: 15, source: "warned", variant: "classic" } },
    { label: "severity 2 with a bare number as enforced", rule: [2, 10], expected: { max: 10, source: "enforced", variant: "classic" } },
    { label: "the older `maximum` key", rule: [2, { maximum: 12 }], expected: { max: 12, source: "enforced", variant: "classic" } },
    { label: "the modified variant", rule: [2, { max: 8, variant: "modified" }], expected: { max: 8, source: "enforced", variant: "modified" } },
    { label: "a variant without a max as ESLint's default max", rule: [1, { variant: "modified" }], expected: { max: 20, source: "warned", variant: "modified" } },
    { label: "a severity alone as the default max", rule: "error", expected: { max: 20, source: "enforced", variant: "classic" } },
  ]

  for (const { label, rule, expected } of cases) {
    it(`reads ${label}`, () => {
      assert.deepStrictEqual(parseBudget(rule), expected)
    })
  }
})

const entry = (overrides: Partial<GrowthEntry>): GrowthEntry => ({
  path: "src/a.ts",
  basePath: "src/a.ts",
  name: "run",
  headLine: 1,
  base: 18,
  head: 25,
  budget: 20,
  budgetSource: "default",
  pairedBy: "name",
  ...overrides,
})

describe("formatLine", () => {
  const measured = { status: "measured", measured: 61, rose: 14, measuredFiles: 3, budgets: ["20 (default)"], listed: [], notMeasured: [] } as const

  it("lists the functions past the budget with their numbers", () => {
    const listed = [
      entry({ path: "src/vault-mcp/vault-operations/task-mutations.ts", name: "updateTask › callback (withExclusiveFileLock)", base: 47, head: 53 }),
      entry({ path: "src/search/search-index.ts", name: "createSearchIndex", base: 86, head: 88 }),
    ]

    assert.equal(
      formatLine({ ...measured, listed }),
      "14 of 61 measured functions rose; 2 past budget 20 (default): src/vault-mcp/vault-operations/task-mutations.ts updateTask › callback (withExclusiveFileLock) 47 → 53, src/search/search-index.ts createSearchIndex 86 → 88",
    )
  })

  it("writes `new` for a function the change added", () => {
    const listed = [entry({ name: "buildPlan", base: null, head: 25, pairedBy: null })]

    assert.equal(formatLine({ ...measured, listed }), "14 of 61 measured functions rose; 1 past budget 20 (default): src/a.ts buildPlan new → 25")
  })

  it("says none past the budget when nothing is listed", () => {
    assert.equal(formatLine({ ...measured, measured: 40, rose: 3, budgets: ["20 (enforced)"] }), "3 of 40 measured functions rose; none past budget 20 (enforced)")
  })

  it("joins the budgets of files configured differently", () => {
    assert.equal(formatLine({ ...measured, budgets: ["20 (default)", "15 (enforced)"] }), "14 of 61 measured functions rose; none past budget 20 (default) / 15 (enforced)")
  })

  it("names eight functions at most, then counts the rest", () => {
    const listed = Array.from({ length: 10 }, (_, index) => entry({ name: `step${index + 1}` }))
    const shown = listed.slice(0, 8).map((listedEntry) => `src/a.ts ${listedEntry.name} 18 → 25`).join(", ")

    assert.equal(formatLine({ ...measured, listed }), `14 of 61 measured functions rose; 10 past budget 20 (default): ${shown}, +2 more`)
  })

  it("adds the files it could not measure with the first reason", () => {
    const notMeasured = [
      { path: "src/a.ts", reason: "Parsing error: Variable declaration expected." },
      { path: "src/b.ts", reason: "no TypeScript parser" },
    ]

    assert.equal(
      formatLine({ ...measured, notMeasured }),
      "14 of 61 measured functions rose; none past budget 20 (default); not measured: 2 files (Parsing error: Variable declaration expected.)",
    )
  })

  it("counts one file it could not measure in the singular", () => {
    const notMeasured = [{ path: "src/b.ts", reason: "no TypeScript parser" }]

    assert.equal(formatLine({ ...measured, notMeasured }), "14 of 61 measured functions rose; none past budget 20 (default); not measured: 1 file (no TypeScript parser)")
  })

  it("says no measurable files when the change touched none", () => {
    assert.equal(formatLine({ ...measured, measured: 0, rose: 0, measuredFiles: 0, budgets: [] }), "no measurable files")
  })

  it("says no measurable files, with the reason, when every file failed", () => {
    const notMeasured = [{ path: "src/b.ts", reason: "no TypeScript parser" }]

    assert.equal(formatLine({ ...measured, measured: 0, rose: 0, measuredFiles: 0, budgets: [], notMeasured }), "no measurable files; not measured: 1 file (no TypeScript parser)")
  })

  it("says not measured when the tooling folder has no ESLint", () => {
    assert.equal(formatLine({ status: "no eslint", tooling: "/work/repo" }), "not measured (no ESLint in /work/repo)")
  })
})

describe("buildReport", () => {
  const DEFAULT = { max: 20, source: "default", variant: "classic" } as const

  it("lists the lock callback's rise past the default budget", () => {
    const fixture = readFixture("lock-callback.json")
    const head = measuredCopy(fixture.head)
    const measurement: FileMeasurement = {
      path: fixture.lintPath,
      basePath: fixture.lintPath,
      budget: DEFAULT,
      head,
      paired: pairFunctions(measuredCopy(baseOf(fixture)), head),
    }
    const callback = {
      path: "src/vault-mcp/vault-operations/task-mutations.ts",
      basePath: "src/vault-mcp/vault-operations/task-mutations.ts",
      name: "updateTask › callback (withExclusiveFileLock)",
      headLine: 2446,
      base: 47,
      head: 53,
      budget: 20,
      budgetSource: "default",
      pairedBy: "name",
    }

    assert.deepStrictEqual(buildReport([measurement]), {
      line: "1 of 2 measured functions rose; 1 past budget 20 (default): src/vault-mcp/vault-operations/task-mutations.ts updateTask › callback (withExclusiveFileLock) 47 → 53",
      measured: 2,
      rose: 1,
      functions: [{ ...callback, name: "updateTask", headLine: 2424, base: 1, head: 1 }, callback],
      listed: [callback],
      notMeasured: [],
    })
  })

  it("counts a rise under the budget without listing it, and lists a new function past it", () => {
    const under: MeasuredFunction = { name: "pick", enclosing: null, line: 3, complexity: 12 }
    const before: MeasuredFunction = { ...under, complexity: 9 }
    const added: MeasuredFunction = { name: "choose", enclosing: null, line: 9, complexity: 21 }
    const addedUnder: MeasuredFunction = { name: "small", enclosing: null, line: 12, complexity: 2 }
    const measurement: FileMeasurement = {
      path: "src/a.ts",
      basePath: "src/a.ts",
      budget: DEFAULT,
      head: [under, added, addedUnder],
      paired: { pairs: [{ base: before, head: under, pairedBy: "name" }], added: [added, addedUnder] },
    }

    assert.deepStrictEqual(buildReport([measurement, { path: "src/b.ts", reason: "no TypeScript parser" }]), {
      line: "1 of 3 measured functions rose; 1 past budget 20 (default): src/a.ts choose new → 21; not measured: 1 file (no TypeScript parser)",
      measured: 3,
      rose: 1,
      functions: [entry({ name: "pick", headLine: 3, base: 9, head: 12 })],
      listed: [entry({ name: "choose", headLine: 9, base: null, head: 21, pairedBy: null })],
      notMeasured: [{ path: "src/b.ts", reason: "no TypeScript parser" }],
    })
  })
})

const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()

const writeFiles = (repo: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
}

const commitAll = (repo: string, message: string): string => {
  gitIn(repo, "add", "-A")
  gitIn(repo, "-c", "user.name=Sample User", "-c", "user.email=user@example.com", "commit", "-q", "-m", message)
  return gitIn(repo, "rev-parse", "HEAD")
}

describe("command line", () => {
  it("prints not measured and exits 0, before any git call, when the tooling folder has no ESLint", () => {
    // The folder is no git repository, so any git call would fail with exit 2.
    const folder = temporaryFolder()

    assert.deepStrictEqual(runScript(["--repo", folder, "--from", "main", "--to", "HEAD"]), {
      status: 0,
      stdout: `not measured (no ESLint in ${folder})\n`,
      stderr: "",
    })
  })

  it("prints the not-measured result as JSON with --json", () => {
    const folder = temporaryFolder()
    const { status, stdout } = runScript(["--json", "--repo", folder, "--from", "main", "--to", "HEAD"])

    assert.equal(status, 0)
    assert.deepStrictEqual(JSON.parse(stdout), {
      line: `not measured (no ESLint in ${folder})`,
      measured: 0,
      rose: 0,
      functions: [],
      listed: [],
      notMeasured: [],
    })
  })

  it("exits 1 when a commit starts with a dash", () => {
    const folder = temporaryFolder()

    assert.deepStrictEqual(runScript(["--repo", folder, "--from=--output=x", "--to", "HEAD"]), {
      status: 1,
      stdout: "",
      stderr: "--from and --to must name commits, not options\n",
    })
  })

  it("exits 1 when --repo is missing", () => {
    assert.deepStrictEqual(runScript(["--from", "main", "--to", "HEAD"]), { status: 1, stdout: "", stderr: "--repo, --from and --to are required\n" })
  })

  it("exits 2 when git cannot read the range", () => {
    const repo = temporaryFolder()
    gitIn(repo, "init", "-q", "-b", "main")
    writeFiles(repo, { "src/a.ts": "export const a = 1\n" })
    commitAll(repo, "base")
    // A stand-in ESLint package: git fails before the script calls into it.
    const tooling = temporaryFolder()
    writeFiles(tooling, {
      "node_modules/eslint/package.json": JSON.stringify({ name: "eslint", type: "module", main: "index.js" }),
      "node_modules/eslint/index.js": "export class ESLint {}\n",
    })
    const { status, stdout, stderr } = runScript(["--repo", repo, "--tooling", tooling, "--from", "missing-commit", "--to", "HEAD"])

    assert.deepStrictEqual({ status, stdout }, { status: 2, stdout: "" })
    assert.match(stderr, /^git diff --name-status -M -z --diff-filter=d missing-commit HEAD -- failed: fatal: bad revision 'missing-commit'\n$/)
  })
})

describe("with a real ESLint from FUNCTION_GROWTH_TOOLING_REPO", () => {
  const toolingRepoPath = (): string => {
    if (!TOOLING_REPO) throw new Error(NO_TOOLING_REASON)
    return TOOLING_REPO
  }

  it("measures a change in a fixture repository end to end", NEEDS_TOOLING, () => {
    const repo = temporaryFolder()
    gitIn(repo, "init", "-q", "-b", "main")
    writeFiles(repo, {
      "eslint.config.mjs": 'export default [{ files: ["**/*.ts"], rules: { complexity: ["warn", { max: 3 }] } }]\n',
      "src/rise.ts": "export const grow = (first: boolean, second: boolean): number => {\n  if (first) return 1\n  if (second) return 2\n  return 3\n}\n",
      "src/small.ts": "export const pick = (flag: boolean): number => (flag ? 1 : 2)\n",
      "src/old-name.ts": "export const keep = (value: number): number => value\n",
      "src/__tests__/grow.test.ts": "export const branchy = (a: boolean, b: boolean, c: boolean): boolean => (a && b) || c\n",
      "notes.md": "# Notes\n",
    })
    const base = commitAll(repo, "base")
    rmSync(join(repo, "src/old-name.ts"))
    writeFiles(repo, {
      "src/rise.ts": "export const grow = (first: boolean, second: boolean, third: boolean): number => {\n  if (first) return 1\n  if (second) return 2\n  if (third) return 3\n  return 4\n}\n",
      "src/small.ts": "export const pick = (flag: boolean): number => (flag ? 1 : 2) || 3\n",
      "src/new-name.ts": "export const keep = (value: number): number => value\n",
      "src/added.ts": "export const choose = (a: boolean, b: boolean, c: boolean): number => {\n  if (a) return 1\n  if (b) return 2\n  if (c) return 3\n  return 4\n}\n",
      "src/broken.ts": "export const = 1\n",
      "src/__tests__/grow.test.ts": "export const branchy = (a: boolean, b: boolean, c: boolean, d: boolean): boolean => (a && b) || (c && d)\n",
      "notes.md": "# Notes\n\nMore.\n",
    })
    const head = commitAll(repo, "change")
    const { status, stdout, stderr } = runScript(["--json", "--repo", repo, "--tooling", toolingRepoPath(), "--from", base, "--to", head])
    const budget = { budget: 3, budgetSource: "warned" }
    const grow = { path: "src/rise.ts", basePath: "src/rise.ts", name: "grow", headLine: 1, base: 3, head: 4, ...budget, pairedBy: "name" }
    const choose = { path: "src/added.ts", basePath: null, name: "choose", headLine: 1, base: null, head: 4, ...budget, pairedBy: null }

    assert.deepStrictEqual({ status, stderr }, { status: 0, stderr: "" })
    assert.deepStrictEqual(JSON.parse(stdout), {
      line: "2 of 4 measured functions rose; 2 past budget 3 (warned): src/added.ts choose new → 4, src/rise.ts grow 3 → 4; not measured: 1 file (Parsing error: Variable declaration expected.)",
      measured: 4,
      rose: 2,
      functions: [
        { path: "src/new-name.ts", basePath: "src/old-name.ts", name: "keep", headLine: 1, base: 1, head: 1, ...budget, pairedBy: "name" },
        grow,
        { path: "src/small.ts", basePath: "src/small.ts", name: "pick", headLine: 1, base: 2, head: 3, ...budget, pairedBy: "name" },
      ],
      listed: [choose, grow],
      notMeasured: [{ path: "src/broken.ts", reason: "Parsing error: Variable declaration expected." }],
    })
  })

  const freshCopy = async (fixture: Fixture, copy: FixtureCopy): Promise<{ messages: LintMessage[]; spans: FunctionSpan[] }> => {
    const toolingRepo = toolingRepoPath()
    const tooling = await loadTooling(toolingRepo)
    if (!tooling) throw new Error(`no ESLint in ${toolingRepo}`)

    const code = copy.source ?? execFileSync("git", ["-C", toolingRepo, "show", `${copy.commit}:${copy.path}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    const { messages, tree } = await createLinter(tooling, toolingRepo, "classic")(code, join(toolingRepo, fixture.lintPath))
    if (!tree) throw new Error(`${copy.path}: ESLint returned no syntax tree`)
    return { messages, spans: extractFunctionSpans(tree.ast, tree.text) }
  }

  // Spans compare by where their enclosing span starts, since a fixture keeps only some of a file's spans.
  const withEnclosingStart = (spans: readonly FunctionSpan[]): unknown[] => {
    return spans.map((span) => ({ ...span, enclosing: span.enclosing === null ? null : (spans[span.enclosing]?.start ?? null) }))
  }

  for (const name of FIXTURE_NAMES) {
    it(`reproduces the recorded messages and spans of ${name}`, NEEDS_TOOLING, async () => {
      const fixture = readFixture(name)

      for (const copy of [fixture.base, fixture.head].filter((side) => side !== undefined)) {
        const fresh = await freshCopy(fixture, copy)
        const freshSpans = withEnclosingStart(fresh.spans)
        const freshMessages = fresh.messages.map(({ ruleId, message, line, column, endLine, endColumn }) => ({ ruleId, message, line, column, endLine, endColumn }))

        assert.deepStrictEqual(withEnclosingStart(copy.spans).filter((span) => !freshSpans.some((freshSpan) => isDeepStrictEqual(freshSpan, span))), [])
        assert.deepStrictEqual(copy.messages.filter((message) => !freshMessages.some((freshMessage) => isDeepStrictEqual(freshMessage, message))), [])
      }
    })
  }
})
