import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
  type ChangedFile,
  type FileSide,
  type PlanResult,
  InputError,
  changedParts,
  commonSubstrings,
  compareSurfaces,
  decideSince,
  listVariants,
  parameterTexts,
  parseSurface,
  planReview,
  showTools,
} from "../surface-diff.ts"

const SCRIPT_PATH = fileURLToPath(new URL("../surface-diff.ts", import.meta.url))

const USAGE = [
  "Usage: surface-diff.ts --current <file> [--base <file>] [--names]",
  "       surface-diff.ts --current <file> --variants <file> [--variants <file> ...]",
  "       surface-diff.ts --current <file> --show <tool> [--show <tool> ...]",
  "       surface-diff.ts --plan --repo <dir> --from <ref> --to <ref> [--since <ref> --since-from <ref>] --out <new dir>",
].join("\n")

// '{"type":"object","properties":{}}' is 33 characters and "List notes." is 11.
const EMPTY_SCHEMA_CHARS = 33
const LIST_NOTES_CHARS = 11 + EMPTY_SCHEMA_CHARS

const PATHS = { base: "base.json", current: "current.json" }

// Every field of the full report, in the order the script prints them. `--names` prints six of them.
const REPORT_FIELDS = [
  "current",
  "base",
  "changed",
  "added",
  "removed",
  "unchanged",
  "orderOnly",
  "inScope",
  "changes",
  "sizes",
  "totalSize",
  "sharedEdits",
  "sections",
  "duplicationCandidates",
]

const emptySchema = () => ({ type: "object", properties: {} })

const pathSchema = (description: string) => ({
  type: "object",
  properties: { path: { type: "string", description } },
})

const rawTool = (overrides: Record<string, unknown> = {}) => ({
  name: "list_notes",
  description: "List notes.",
  inputSchema: emptySchema(),
  ...overrides,
})

const surfaceOf = (tools: unknown[], sections: Record<string, unknown> = {}) => {
  return parseSurface({ ...sections, tools }, "test")
}

const parsedTool = (overrides: Record<string, unknown> = {}) => {
  const [tool] = surfaceOf([rawTool(overrides)]).tools

  if (!tool) {
    throw new Error("surfaceOf returned no tool")
  }

  return tool
}

const compare = (baseTools: unknown[] | null, currentTools: unknown[]) => {
  return compareSurfaces(baseTools ? surfaceOf(baseTools) : null, surfaceOf(currentTools), {
    base: baseTools ? PATHS.base : null,
    current: PATHS.current,
  })
}

describe("parseSurface", () => {
  const expectedSurface = {
    tools: [
      {
        name: "list_notes",
        inputSchema: { type: "object", properties: {} },
        description: "List notes.",
        title: undefined,
        outputSchema: undefined,
        annotations: undefined,
      },
    ],
    sections: {},
  }

  const acceptedShapes = [
    { label: "an object with a tools array", input: { tools: [rawTool()] } },
    { label: "a bare array of tools", input: [rawTool()] },
    { label: "a JSON-RPC result holding tools", input: { jsonrpc: "2.0", id: 1, result: { tools: [rawTool()] } } },
  ]

  for (const { label, input } of acceptedShapes) {
    it(`loads ${label}`, () => {
      assert.deepStrictEqual(parseSurface(input, "test"), expectedSurface)
    })
  }

  it("keeps a snapshot's instructions and prompts as sections and drops its other keys", () => {
    const surface = surfaceOf([], { env: { MODE: "default" }, instructions: "Read first.", prompts: [{ name: "daily" }] })

    assert.deepStrictEqual(surface, {
      tools: [],
      sections: { instructions: "Read first.", prompts: [{ name: "daily" }] },
    })
  })

  const rejectedInputs = [
    {
      label: "a file with no tool list",
      input: { server: "vault" },
      message:
        'test: not a tool list (expected a "tools" array, a bare array of tools, or a JSON-RPC result holding "tools")',
    },
    {
      label: "a tool without a name",
      input: { tools: [{ inputSchema: emptySchema() }] },
      message: 'test: tool 1 has no string "name"',
    },
    {
      label: "a tool name that carries shell syntax",
      input: { tools: [rawTool({ name: "list_notes; touch /tmp/x" })] },
      message:
        'test: tool 1 is named "list_notes; touch /tmp/x"; a name may hold only letters, digits, and _ . : / - because the reviewer puts names on a command line',
    },
    {
      label: "a tool without an input schema",
      input: { tools: [{ name: "list_notes" }] },
      message: 'test: tool "list_notes": "inputSchema" must be an object',
    },
    {
      label: "a numeric description",
      input: { tools: [rawTool({ description: 7 })] },
      message: 'test: tool "list_notes": "description" must be a string',
    },
    {
      label: "an output schema that is not an object",
      input: { tools: [rawTool({ outputSchema: "none" })] },
      message: 'test: tool "list_notes": "outputSchema" must be an object',
    },
    {
      label: "a tool entry that is not an object",
      input: { tools: ["not a tool"] },
      message: "test: tool 1 is not an object",
    },
    {
      label: "a non-string title",
      input: { tools: [rawTool({ title: true })] },
      message: 'test: tool "list_notes": "title" must be a string',
    },
    {
      label: "non-object annotations",
      input: { tools: [rawTool({ annotations: [1] })] },
      message: 'test: tool "list_notes": "annotations" must be an object',
    },
    {
      label: "two tools with one name",
      input: { tools: [rawTool(), rawTool()] },
      message: 'test: two tools are named "list_notes"',
    },
    {
      label: "one page of a paginated list",
      input: { tools: [rawTool()], nextCursor: "page-2" },
      message: 'test: has "nextCursor", so it is one page of a longer list; capture every page',
    },
  ]

  for (const { label, input, message } of rejectedInputs) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseSurface(input, "test"), { constructor: InputError, message })
    })
  }
})

describe("changedParts", () => {
  const partCases = [
    { label: "a one-character description edit", change: { description: "List notes!" }, parts: ["description"] },
    { label: "a schema description edit", change: { inputSchema: pathSchema("Note path.") }, parts: ["inputSchema"] },
    { label: "an added output schema", change: { outputSchema: { type: "object" } }, parts: ["outputSchema"] },
    { label: "a title edit", change: { title: "List" }, parts: ["title"] },
    { label: "an annotations edit", change: { annotations: { readOnlyHint: true } }, parts: ["annotations"] },
  ]

  for (const { label, change, parts } of partCases) {
    it(`names the part for ${label}`, () => {
      assert.deepStrictEqual(changedParts(parsedTool(), parsedTool(change)), parts)
    })
  }

  it("reports nothing when a schema differs only in key order", () => {
    const base = parsedTool({ inputSchema: { type: "object", properties: { path: { type: "string" } } } })
    const reordered = parsedTool({ inputSchema: { properties: { path: { type: "string" } }, type: "object" } })

    assert.deepStrictEqual(changedParts(base, reordered), [])
  })

  it("reports a schema whose array order changed", () => {
    const base = parsedTool({ inputSchema: { type: "object", required: ["path", "body"] } })
    const reordered = parsedTool({ inputSchema: { type: "object", required: ["body", "path"] } })

    assert.deepStrictEqual(changedParts(base, reordered), ["inputSchema"])
  })
})

describe("compareSurfaces", () => {
  it("reports a description edit with its lines, sizes, and scope", () => {
    const report = compare([rawTool()], [rawTool({ description: "List notes!" })])

    assert.deepStrictEqual(report, {
      current: "current.json",
      base: "base.json",
      changed: ["list_notes"],
      added: [],
      removed: [],
      unchanged: [],
      orderOnly: [],
      inScope: ["list_notes"],
      changes: [
        {
          name: "list_notes",
          parts: ["description"],
          sizeBefore: LIST_NOTES_CHARS,
          sizeAfter: LIST_NOTES_CHARS,
          descriptionLines: { added: ["List notes!"], removed: ["List notes."] },
          schemaSentences: { added: [], removed: [] },
        },
      ],
      sizes: [
        { name: "list_notes", description: 11, inputSchema: EMPTY_SCHEMA_CHARS, outputSchema: 0, total: LIST_NOTES_CHARS },
      ],
      totalSize: { base: LIST_NOTES_CHARS, current: LIST_NOTES_CHARS },
      sharedEdits: [],
      sections: [],
      duplicationCandidates: [],
    })
  })

  it("reports a removed line when a description loses one of two identical lines", () => {
    const report = compare(
      [rawTool({ description: "List notes.\n- repeated\n- repeated" })],
      [rawTool({ description: "List notes.\n- repeated" })],
    )

    assert.deepStrictEqual(
      report.changes.map((change) => change.descriptionLines),
      [{ added: [], removed: ["- repeated"] }],
    )
  })

  it("keeps a key-order-only change out of scope and marks it order-only", () => {
    const base = rawTool({ inputSchema: { type: "object", properties: {} } })
    const reordered = rawTool({ inputSchema: { properties: {}, type: "object" } })

    assert.deepStrictEqual(compare([base], [reordered]), {
      current: "current.json",
      base: "base.json",
      changed: [],
      added: [],
      removed: [],
      unchanged: ["list_notes"],
      orderOnly: ["list_notes"],
      inScope: [],
      changes: [],
      sizes: [],
      totalSize: { base: LIST_NOTES_CHARS, current: LIST_NOTES_CHARS },
      sharedEdits: [],
      sections: [],
      duplicationCandidates: [],
    })
  })

  it("lists an added and a removed tool and puts only the added one in scope", () => {
    const kept = rawTool({ name: "read_note", description: "" })
    const report = compare(
      [rawTool({ name: "old_tool", description: "" }), kept],
      [kept, rawTool({ name: "new_tool", description: "" })],
    )

    assert.deepStrictEqual(report, {
      current: "current.json",
      base: "base.json",
      changed: [],
      added: ["new_tool"],
      removed: ["old_tool"],
      unchanged: ["read_note"],
      orderOnly: [],
      inScope: ["new_tool"],
      changes: [],
      sizes: [
        { name: "new_tool", description: 0, inputSchema: EMPTY_SCHEMA_CHARS, outputSchema: 0, total: EMPTY_SCHEMA_CHARS },
      ],
      totalSize: { base: 2 * EMPTY_SCHEMA_CHARS, current: 2 * EMPTY_SCHEMA_CHARS },
      sharedEdits: [],
      sections: [],
      duplicationCandidates: [],
    })
  })

  it("puts every tool in scope when there is no base", () => {
    assert.deepStrictEqual(compare(null, [rawTool(), rawTool({ name: "read_note", description: "" })]), {
      current: "current.json",
      base: null,
      changed: [],
      added: [],
      removed: [],
      unchanged: [],
      orderOnly: [],
      inScope: ["list_notes", "read_note"],
      changes: [],
      sizes: [
        { name: "list_notes", description: 11, inputSchema: EMPTY_SCHEMA_CHARS, outputSchema: 0, total: LIST_NOTES_CHARS },
        { name: "read_note", description: 0, inputSchema: EMPTY_SCHEMA_CHARS, outputSchema: 0, total: EMPTY_SCHEMA_CHARS },
      ],
      totalSize: { base: null, current: LIST_NOTES_CHARS + EMPTY_SCHEMA_CHARS },
      sharedEdits: [],
      sections: [],
      duplicationCandidates: [],
    })
  })

  it("groups a line added to two tools into one shared edit and leaves a one-tool line out", () => {
    const sharedLine = '- "path must end in .md" — add the extension'
    const report = compare(
      [rawTool({ name: "read_note", description: "Read." }), rawTool({ name: "write_note", description: "Write." })],
      [
        rawTool({ name: "read_note", description: `Read.\n${sharedLine}` }),
        rawTool({ name: "write_note", description: `Write.\n${sharedLine}\n- only here` }),
      ],
    )

    assert.deepStrictEqual(report.sharedEdits, [
      { text: sharedLine, where: "description", change: "added", tools: ["read_note", "write_note"] },
    ])
  })

  it("groups a sentence added to two tools' schema descriptions into one shared edit", () => {
    const report = compare(
      [
        rawTool({ name: "read_note", inputSchema: pathSchema("Path to read.") }),
        rawTool({ name: "write_note", inputSchema: pathSchema("Path to write.") }),
      ],
      [
        rawTool({ name: "read_note", inputSchema: pathSchema("Path to read. Use the exact letter case.") }),
        rawTool({ name: "write_note", inputSchema: pathSchema("Path to write. Use the exact letter case.") }),
      ],
    )

    assert.deepStrictEqual(report.sharedEdits, [
      { text: "Use the exact letter case.", where: "schema", change: "added", tools: ["read_note", "write_note"] },
    ])
  })

  it("groups a line removed from two tools into one shared edit", () => {
    const sharedLine = "- Hidden paths are not editable, matching Obsidian"
    const report = compare(
      [
        rawTool({ name: "read_note", description: `Read.\n${sharedLine}` }),
        rawTool({ name: "write_note", description: `Write.\n${sharedLine}` }),
      ],
      [rawTool({ name: "read_note", description: "Read." }), rawTool({ name: "write_note", description: "Write." })],
    )

    assert.deepStrictEqual(report.sharedEdits, [
      { text: sharedLine, where: "description", change: "removed", tools: ["read_note", "write_note"] },
    ])
  })

  it("groups a sentence removed from two tools' schema descriptions into one shared edit", () => {
    const report = compare(
      [
        rawTool({ name: "read_note", inputSchema: pathSchema("Path to read. Must end in md.") }),
        rawTool({ name: "write_note", inputSchema: pathSchema("Path to write. Must end in md.") }),
      ],
      [
        rawTool({ name: "read_note", inputSchema: pathSchema("Path to read.") }),
        rawTool({ name: "write_note", inputSchema: pathSchema("Path to write.") }),
      ],
    )

    assert.deepStrictEqual(report.sharedEdits, [
      { text: "Must end in md.", where: "schema", change: "removed", tools: ["read_note", "write_note"] },
    ])
  })

  it("marks a snapshot's sections as not compared when there is no base", () => {
    const current = surfaceOf([rawTool()], { instructions: "Read first.", prompts: [] })

    assert.deepStrictEqual(compareSurfaces(null, current, { base: null, current: "current.json" }).sections, [
      { name: "instructions", changed: null },
      { name: "prompts", changed: null },
    ])
  })

  it("reports which of a snapshot's sections changed", () => {
    const base = surfaceOf([rawTool()], { instructions: "Read first.", prompts: [] })
    const current = surfaceOf([rawTool()], { instructions: "Read this first.", prompts: [] })

    assert.deepStrictEqual(compareSurfaces(base, current, PATHS).sections, [
      { name: "instructions", changed: true },
      { name: "prompts", changed: false },
    ])
  })

  it("marks a section present only in the base as changed", () => {
    const base = surfaceOf([rawTool()], { instructions: "Read first." })
    const current = surfaceOf([rawTool()])

    assert.deepStrictEqual(compareSurfaces(base, current, PATHS).sections, [
      { name: "instructions", changed: true },
    ])
  })

  it("marks a section present only in the current as changed", () => {
    const base = surfaceOf([rawTool()])
    const current = surfaceOf([rawTool()], { prompts: [{ name: "daily" }] })

    assert.deepStrictEqual(compareSurfaces(base, current, PATHS).sections, [
      { name: "prompts", changed: true },
    ])
  })

  it("includes outputSchema in the size total", () => {
    const outputSchema = { type: "object", properties: { count: { type: "number" } } }
    const report = compare(null, [rawTool({ outputSchema })])
    const outputSchemaChars = JSON.stringify(outputSchema).length

    assert.deepStrictEqual(report.sizes, [
      {
        name: "list_notes",
        description: 11,
        inputSchema: EMPTY_SCHEMA_CHARS,
        outputSchema: outputSchemaChars,
        total: 11 + EMPTY_SCHEMA_CHARS + outputSchemaChars,
      },
    ])
  })
})

describe("findSharedEdits", () => {
  it("keeps edits that touched only one tool out of the result", () => {
    const report = compare(
      [rawTool({ name: "read_note", description: "Read." })],
      [rawTool({ name: "read_note", description: "Read a note." })],
    )

    assert.deepStrictEqual(
      { changed: report.changed, sharedEdits: report.sharedEdits },
      { changed: ["read_note"], sharedEdits: [] },
    )
  })
})

describe("duplication candidates", () => {
  const overlapOf = (length: number) => "s".repeat(length)

  it("ignores an overlap one character under the threshold", () => {
    assert.deepStrictEqual(commonSubstrings(`1${overlapOf(39)}2`, `3${overlapOf(39)}4`), [])
  })

  it("reports an overlap at the threshold", () => {
    assert.deepStrictEqual(commonSubstrings(`1${overlapOf(40)}2`, `3${overlapOf(40)}4`), [overlapOf(40)])
  })

  it("reports every separate overlap in one text, longest first", () => {
    const shorter = "a".repeat(45)
    const longer = "b".repeat(50)

    assert.deepStrictEqual(commonSubstrings(`${shorter}|${longer}`, `${longer}#${shorter}`), [longer, shorter])
  })

  it("reports an overlap once when the text states it twice", () => {
    const repeated = overlapOf(40)

    assert.deepStrictEqual(commonSubstrings(`x${repeated}y${repeated}`, `${repeated}z`), [repeated])
  })

  it("drops a candidate that reaches the threshold only by counting a neighbouring space", () => {
    const report = compare(null, [
      rawTool({ description: `3 ${overlapOf(39)}4`, inputSchema: pathSchema(`1 ${overlapOf(39)}2`) }),
    ])

    assert.deepStrictEqual(report.duplicationCandidates, [])
  })

  it("leaves half of a two-unit character out of a candidate's text", () => {
    // 😀 and 🨀 share their second code unit, and 😀 and 😁 share their first, so the raw overlap starts and ends mid-character.
    const report = compare(null, [
      rawTool({ description: `🨀${overlapOf(40)}😀`, inputSchema: pathSchema(`😀${overlapOf(40)}😁`) }),
    ])

    assert.deepStrictEqual(report.duplicationCandidates, [
      { tool: "list_notes", parameter: "path", text: overlapOf(40), length: 40, preExisting: false },
    ])
  })

  it("finds described parameters in nested properties, items, and anyOf branches", () => {
    const schema = {
      type: "object",
      description: "The root is not a parameter.",
      properties: {
        path: { type: "string", description: "Top level." },
        filters: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string", description: "One tag." } } },
        },
        position: { anyOf: [{ type: "string", description: "Top or bottom." }, { type: "integer" }] },
      },
    }

    assert.deepStrictEqual(parameterTexts(schema), [
      { parameter: "path", text: "Top level." },
      { parameter: "filters.tags[]", text: "One tag." },
      { parameter: "position", text: "Top or bottom." },
    ])
  })

  it("follows oneOf and allOf branches the same way as anyOf", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { oneOf: [{ type: "string", description: "Named mode." }] },
        spec: { allOf: [{ description: "Base constraints." }, { description: "Extended constraints." }] },
      },
    }

    assert.deepStrictEqual(parameterTexts(schema), [
      { parameter: "mode", text: "Named mode." },
      { parameter: "spec", text: "Base constraints." },
      { parameter: "spec", text: "Extended constraints." },
    ])
  })

  it("returns nothing when the schema is not an object", () => {
    assert.deepStrictEqual(parameterTexts("not a schema"), [])
    assert.deepStrictEqual(parameterTexts(undefined), [])
  })

  it("labels an overlap the base already had and still reports a new one in the same parameter", () => {
    const oldOverlap = "o".repeat(60)
    const newOverlap = "n".repeat(45)
    const report = compare(
      [rawTool({ description: `Old: ${oldOverlap}`, inputSchema: pathSchema(`1${oldOverlap}2`) })],
      [
        rawTool({
          description: `Old: ${oldOverlap} New: ${newOverlap}`,
          inputSchema: pathSchema(`1${oldOverlap}2 3${newOverlap}4`),
        }),
      ],
    )

    assert.deepStrictEqual(report.duplicationCandidates, [
      { tool: "list_notes", parameter: "path", text: oldOverlap, length: 60, preExisting: true },
      { tool: "list_notes", parameter: "path", text: newOverlap, length: 45, preExisting: false },
    ])
  })
})

describe("duplication candidates across a change", () => {
  it("keeps an overlap pre-existing when the change only adds a sentence after it", () => {
    const repeated = "The note must already exist and must end in md."
    const report = compare(
      [rawTool({ description: `Path rules: ${repeated}`, inputSchema: pathSchema(repeated) })],
      [rawTool({ description: `Path rules: ${repeated}`, inputSchema: pathSchema(`${repeated} Use the exact letter case.`) })],
    )

    assert.deepStrictEqual(report.duplicationCandidates, [
      { tool: "list_notes", parameter: "path", text: repeated, length: 47, preExisting: true },
    ])
  })
})

describe("listVariants", () => {
  it("names the tools another configuration words differently, and the tools only one side has", () => {
    const current = surfaceOf([
      rawTool({ name: "search", description: "Hybrid search." }),
      rawTool({ name: "read_note" }),
      rawTool({ name: "recall" }),
    ])
    const embeddingOff = surfaceOf([
      rawTool({ name: "search", description: "Full-text search." }),
      rawTool({ name: "read_note" }),
      rawTool({ name: "reindex" }),
    ])

    assert.deepStrictEqual(listVariants(current, [{ file: "embedding-off.json", surface: embeddingOff }]), [
      {
        file: "embedding-off.json",
        differing: [{ name: "search", parts: ["description"] }],
        onlyInCurrent: ["recall"],
        onlyInVariant: ["reindex"],
      },
    ])
  })
})

describe("showTools", () => {
  it("prints the named tools as text, with the description's own line breaks", () => {
    const surface = surfaceOf([
      rawTool({ description: "List notes.\n\nReturns: paths.", title: "List", annotations: { readOnlyHint: true } }),
      rawTool({ name: "read_note", description: "Read a note.", outputSchema: { type: "object" } }),
      rawTool({ name: "not_asked_for" }),
    ])

    assert.strictEqual(
      showTools(surface, ["list_notes", "read_note"], "test"),
      [
        "=== list_notes ===",
        "title: List",
        "description:",
        "List notes.",
        "",
        "Returns: paths.",
        "",
        "inputSchema:",
        "{",
        '  "type": "object",',
        '  "properties": {}',
        "}",
        "",
        'annotations: {"readOnlyHint":true}',
        "",
        "=== read_note ===",
        "description:",
        "Read a note.",
        "",
        "inputSchema:",
        "{",
        '  "type": "object",',
        '  "properties": {}',
        "}",
        "",
        "outputSchema:",
        "{",
        '  "type": "object"',
        "}",
      ].join("\n"),
    )
  })

  it("rejects a name the file does not hold", () => {
    assert.throws(() => showTools(surfaceOf([rawTool()]), ["read_note"], "test"), {
      constructor: InputError,
      message: 'test: no tool named "read_note"',
    })
  })
})

describe("command line", () => {
  const directory = mkdtempSync(join(tmpdir(), "surface-diff-test-"))
  after(() => rmSync(directory, { recursive: true, force: true }))

  const writeFile = (name: string, content: string) => {
    const path = join(directory, name)
    writeFileSync(path, content)
    return path
  }

  const writeSurface = (name: string, tools: unknown[]) => writeFile(name, JSON.stringify({ tools }))

  const runScript = (args: string[]) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" })
    return { status, stdout, stderr }
  }

  it("prints only names with --names", () => {
    const base = writeSurface("names-base.json", [rawTool(), rawTool({ name: "read_note" })])
    const current = writeSurface("names-current.json", [rawTool({ description: "List every note." }), rawTool({ name: "read_note" })])

    const { status, stdout, stderr } = runScript(["--current", current, "--base", base, "--names"])

    assert.deepStrictEqual(
      { status, stderr, output: JSON.parse(stdout) },
      {
        status: 0,
        stderr: "",
        output: {
          changed: ["list_notes"],
          added: [],
          removed: [],
          unchanged: ["read_note"],
          orderOnly: [],
          inScope: ["list_notes"],
        },
      },
    )
  })

  it("lists another configuration's differing tools with --variants", () => {
    const current = writeSurface("variants-current.json", [rawTool()])
    const variant = writeSurface("variants-readonly.json", [rawTool({ description: "List notes, read-only." })])

    const { status, stdout, stderr } = runScript(["--current", current, "--variants", variant])

    assert.deepStrictEqual(
      { status, stderr, output: JSON.parse(stdout) },
      {
        status: 0,
        stderr: "",
        output: {
          current,
          variants: [
            {
              file: variant,
              differing: [{ name: "list_notes", parts: ["description"] }],
              onlyInCurrent: [],
              onlyInVariant: [],
            },
          ],
        },
      },
    )
  })

  it("exits 2 with the usage when --current is missing", () => {
    assert.deepStrictEqual(runScript([]), { status: 2, stdout: "", stderr: `${USAGE}\n` })
  })

  it("exits 2 when the file cannot be read", () => {
    const missing = join(directory, "missing.json")

    assert.deepStrictEqual(runScript(["--current", missing]), {
      status: 2,
      stdout: "",
      stderr: `${missing}: cannot be read\n`,
    })
  })

  it("exits 2 when the file is not JSON", () => {
    const broken = writeFile("broken.json", "{ not json")

    assert.deepStrictEqual(runScript(["--current", broken]), {
      status: 2,
      stdout: "",
      stderr: `${broken}: not valid JSON\n`,
    })
  })

  it("exits 2 when the file holds one page of a paginated list", () => {
    const page = writeFile("page.json", JSON.stringify({ tools: [rawTool()], nextCursor: "page-2" }))

    assert.deepStrictEqual(runScript(["--current", page]), {
      status: 2,
      stdout: "",
      stderr: `${page}: has "nextCursor", so it is one page of a longer list; capture every page\n`,
    })
  })

  it("prints a tool as text with --show", () => {
    const current = writeSurface("show-current.json", [rawTool({ description: "List notes.\nSecond line." })])

    assert.deepStrictEqual(runScript(["--current", current, "--show", "list_notes"]), {
      status: 0,
      stdout: [
        "=== list_notes ===",
        "description:",
        "List notes.",
        "Second line.",
        "",
        "inputSchema:",
        "{",
        '  "type": "object",',
        '  "properties": {}',
        "}",
        "",
      ].join("\n"),
      stderr: "",
    })
  })

  it("exits 2 when --show is combined with --base", () => {
    const current = writeSurface("show-combined.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--base", current, "--show", "list_notes"]), {
      status: 2,
      stdout: "",
      stderr: "--show prints tools from --current; it cannot be combined with --base, --names, or --variants\n",
    })
  })

  it("exits 2 when --variants is combined with --base", () => {
    const current = writeSurface("combined-current.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--base", current, "--variants", current]), {
      status: 2,
      stdout: "",
      stderr: "--variants lists other configurations; it cannot be combined with --base or --names\n",
    })
  })

  it("exits 2 when --show is combined with --variants", () => {
    const current = writeSurface("show-variants.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--variants", current, "--show", "list_notes"]), {
      status: 2,
      stdout: "",
      stderr: "--show prints tools from --current; it cannot be combined with --base, --names, or --variants\n",
    })
  })

  it("exits 2 when --names is combined with --show", () => {
    const current = writeSurface("show-names.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--names", "--show", "list_notes"]), {
      status: 2,
      stdout: "",
      stderr: "--show prints tools from --current; it cannot be combined with --base, --names, or --variants\n",
    })
  })

  it("exits 2 when --names is combined with --variants", () => {
    const current = writeSurface("variants-names.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--names", "--variants", current]), {
      status: 2,
      stdout: "",
      stderr: "--variants lists other configurations; it cannot be combined with --base or --names\n",
    })
  })

  it("exits 2 with usage when an unknown flag is passed", () => {
    assert.deepStrictEqual(runScript(["--bogus"]), {
      status: 2,
      stdout: "",
      stderr: `Unknown option '--bogus'\n${USAGE}\n`,
    })
  })

  it("prints a full report with --current and --base", () => {
    const base = writeSurface("full-base.json", [rawTool()])
    const current = writeSurface("full-current.json", [rawTool({ description: "List every note." })])

    const { status, stdout, stderr } = runScript(["--current", current, "--base", base])
    const output = JSON.parse(stdout)

    assert.deepStrictEqual(
      { status, stderr, current: output.current, base: output.base, changed: output.changed, fields: Object.keys(output) },
      { status: 0, stderr: "", current, base, changed: ["list_notes"], fields: REPORT_FIELDS },
    )
  })

  it("prints a full report with --current only", () => {
    const current = writeSurface("solo-current.json", [rawTool()])

    const { status, stdout, stderr } = runScript(["--current", current])
    const output = JSON.parse(stdout)

    assert.deepStrictEqual(
      { status, stderr, current: output.current, base: output.base, inScope: output.inScope, fields: Object.keys(output) },
      { status: 0, stderr: "", current, base: null, inScope: ["list_notes"], fields: REPORT_FIELDS },
    )
  })

  it("exits 2 when --show names a tool the file does not hold", () => {
    const current = writeSurface("show-missing.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--show", "no_such_tool"]), {
      status: 2,
      stdout: "",
      stderr: `${current}: no tool named "no_such_tool"\n`,
    })
  })

  const requiredPlanOptions = { "--repo": directory, "--from": "a", "--to": "b", "--out": join(directory, "x") }

  for (const missing of Object.keys(requiredPlanOptions)) {
    it(`exits 2 when --plan is missing ${missing}`, () => {
      const given = Object.entries(requiredPlanOptions).filter(([option]) => option !== missing)

      assert.deepStrictEqual(runScript(["--plan", ...given.flat()]), {
        status: 2,
        stdout: "",
        stderr: `--plan needs --repo, --from, --to, and --out\n${USAGE}\n`,
      })
    })
  }

  const loneSinceOptions = [
    { label: "--since comes without --since-from", flag: "--since" },
    { label: "--since-from comes without --since", flag: "--since-from" },
  ]

  for (const { label, flag } of loneSinceOptions) {
    it(`exits 2 when ${label}`, () => {
      const args = ["--plan", "--repo", directory, "--from", "a", "--to", "b", flag, "c", "--out", join(directory, "x")]

      assert.deepStrictEqual(runScript(args), {
        status: 2,
        stdout: "",
        stderr: "--since and --since-from go together: the last review's commit and the merge base it used\n",
      })
    })
  }

  // The options of the modes that read --current, each with the arguments it takes.
  const fileModeOptions = [
    { label: "--current", option: (file: string) => ["--current", file] },
    { label: "--base", option: (file: string) => ["--base", file] },
    { label: "--names", option: () => ["--names"] },
    { label: "--variants", option: (file: string) => ["--variants", file] },
    { label: "--show", option: () => ["--show", "list_notes"] },
  ]

  for (const { label, option } of fileModeOptions) {
    it(`exits 2 when --plan is combined with ${label}`, () => {
      const file = writeSurface(`plan-with-${label.slice(2)}.json`, [rawTool()])
      const args = ["--plan", ...option(file), "--repo", directory, "--from", "a", "--to", "b", "--out", join(directory, "y")]

      assert.deepStrictEqual(runScript(args), {
        status: 2,
        stdout: "",
        stderr: "--plan reads the files from git; it cannot be combined with --current, --base, --names, --variants, or --show\n",
      })
    })
  }

  it("exits 2 when a --plan option comes without --plan", () => {
    const current = writeSurface("repo-current.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--repo", directory]), {
      status: 2,
      stdout: "",
      stderr: `--repo, --from, --to, --since, --since-from, and --out belong to --plan\n${USAGE}\n`,
    })
  })
})

const toolListSide = (tools: unknown[], sections: Record<string, unknown> = {}): FileSide => {
  const text = JSON.stringify({ ...sections, tools })
  return { kind: "toolList", surface: parseSurface(JSON.parse(text), "test"), text }
}

const ABSENT: FileSide = { kind: "absent" }

const notToolListSide = (path: string): FileSide => ({ kind: "notToolList", reason: `${path}: not a tool list` })

const changedFile = (path: string, from: FileSide, to: FileSide): ChangedFile => {
  return { path, fromPath: path, from, to, sinceSides: null }
}

const sinceFile = (path: string, sides: { since: FileSide; sinceFrom: FileSide; from: FileSide; to: FileSide }): ChangedFile => {
  const { since, sinceFrom, from, to } = sides
  return { path, fromPath: path, from, to, sinceSides: { path, since, sinceFrom } }
}

const NO_PLAN_FINDINGS = {
  filesWithNoToolChange: [],
  broken: [],
  removed: [],
  removedTools: [],
  addedThenDropped: [],
  notToolLists: [],
}

/** The plan with each base reduced to its kind and path; a composed base's tools are checked by their own tests. */
const summarize = (result: PlanResult) => {
  return {
    ...result,
    files: result.files.map(({ base, ...file }) => ({ ...file, base: base ? { kind: base.kind, path: base.path } : null })),
  }
}

const plannedFile = (path: string, reviewOnly: string[], overrides: Record<string, unknown> = {}) => {
  return {
    path,
    reviewOnly,
    withRoot: true,
    coldDispatch: false,
    batches: [reviewOnly],
    alsoChangedOnBaseBranch: [],
    base: { kind: "fromCopy", path },
    ...overrides,
  }
}

describe("planReview", () => {
  it("plans one traced review of a changed tool in a modified file", () => {
    const from = toolListSide([rawTool(), rawTool({ name: "read_note" })])
    const to = toolListSide([rawTool({ description: "List every note." }), rawTool({ name: "read_note" })])

    assert.deepStrictEqual(summarize(planReview([changedFile("default.json", from, to)])), {
      records: 1,
      files: [plannedFile("default.json", ["list_notes"])],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("keeps two different schema changes to one tool as two traced reviews", () => {
    const pathSchemaOf = (type: string) => ({ type: "object", properties: { path: { type } } })
    const before = toolListSide([rawTool({ inputSchema: pathSchemaOf("string") })])
    const toNumber = toolListSide([rawTool({ inputSchema: pathSchemaOf("number") })])
    const toBoolean = toolListSide([rawTool({ inputSchema: pathSchemaOf("boolean") })])

    const result = planReview([changedFile("a.json", before, toNumber), changedFile("b.json", before, toBoolean)])

    assert.deepStrictEqual(summarize(result), {
      records: 2,
      files: [plannedFile("a.json", ["list_notes"]), plannedFile("b.json", ["list_notes"])],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("traces the same edit once when two configurations word the tool differently", () => {
    const wording = (lead: string, rest: string[]) => rawTool({ description: [lead, ...rest].join("\n") })
    const defaultFile = changedFile(
      "default.json",
      toolListSide([wording("List notes.", ["Old fact."]), rawTool({ name: "read_note" })]),
      toolListSide([wording("List notes.", []), rawTool({ name: "read_note", description: "Read a note." })]),
    )
    const readonlyFile = changedFile(
      "readonly.json",
      toolListSide([wording("List notes, read-only.", ["Old fact."])]),
      toolListSide([wording("List notes, read-only.", [])]),
    )

    assert.deepStrictEqual(summarize(planReview([readonlyFile, defaultFile])), {
      records: 3,
      files: [
        plannedFile("default.json", ["list_notes", "read_note"]),
        plannedFile("readonly.json", ["list_notes"], { withRoot: false }),
      ],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("traces a configuration's own edit even when the tool is reviewed in another file", () => {
    const defaultFile = changedFile("default.json", toolListSide([rawTool()]), toolListSide([rawTool({ description: "List every note." })]))
    const syncFile = changedFile(
      "obsidian-sync.json",
      toolListSide([rawTool({ description: "List notes. Sync may lag." })]),
      toolListSide([rawTool({ description: "List every note. Sync may lag by a minute." })]),
    )

    assert.deepStrictEqual(summarize(planReview([defaultFile, syncFile])), {
      records: 2,
      files: [plannedFile("default.json", ["list_notes"]), plannedFile("obsidian-sync.json", ["list_notes"])],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("treats a new parameter as a different edit from another new parameter, even when both are empty objects", () => {
    const propertiesOf = (properties: Record<string, unknown>) => rawTool({ inputSchema: { type: "object", properties } })
    const before = toolListSide([propertiesOf({})])

    const result = planReview([
      changedFile("a.json", before, toolListSide([propertiesOf({ x: {} })])),
      changedFile("b.json", before, toolListSide([propertiesOf({ y: {} })])),
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 2,
      files: [plannedFile("a.json", ["list_notes"]), plannedFile("b.json", ["list_notes"])],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("counts a constraint on a parameter named description as a schema edit, not description text", () => {
    const describedTool = (lead: string, minLength: number | undefined) => {
      const descriptionParameter = minLength ? { type: "string", minLength } : { type: "string" }
      return rawTool({ description: lead, inputSchema: { type: "object", properties: { description: descriptionParameter } } })
    }

    const result = planReview([
      changedFile("a.json", toolListSide([describedTool("A.", undefined)]), toolListSide([describedTool("A.", 1)])),
      changedFile("b.json", toolListSide([describedTool("B.", undefined)]), toolListSide([describedTool("B.", 1)])),
      changedFile("c.json", toolListSide([describedTool("C.", undefined)]), toolListSide([describedTool("C.", 2)])),
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 3,
      files: [
        plannedFile("a.json", ["list_notes"]),
        plannedFile("b.json", ["list_notes"], { withRoot: false }),
        plannedFile("c.json", ["list_notes"]),
      ],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("traces the same lines added in a different order as one edit", () => {
    const changeFile = (path: string, lead: string, addedLines: string[]) => {
      const before = toolListSide([rawTool({ description: lead })])
      const after = toolListSide([rawTool({ description: [lead, ...addedLines].join("\n") })])
      return changedFile(path, before, after)
    }

    const result = planReview([
      changeFile("a.json", "List notes.", ["First rule.", "Second rule."]),
      changeFile("b.json", "List notes, read-only.", ["Second rule.", "First rule."]),
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 2,
      files: [plannedFile("a.json", ["list_notes"]), plannedFile("b.json", ["list_notes"], { withRoot: false })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("traces a sentence removed from differently worded parameter descriptions as one edit", () => {
    const changeFile = (path: string, lead: string) => {
      const before = toolListSide([rawTool({ inputSchema: pathSchema(`${lead} Must end in md.`) })])
      const after = toolListSide([rawTool({ inputSchema: pathSchema(lead) })])
      return changedFile(path, before, after)
    }

    const result = planReview([changeFile("a.json", "Note path."), changeFile("b.json", "Note path, read-only.")])

    assert.deepStrictEqual(summarize(result), {
      records: 2,
      files: [plannedFile("a.json", ["list_notes"]), plannedFile("b.json", ["list_notes"], { withRoot: false })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("reviews a tool once when two files differ only in the key order of its schema", () => {
    const schemaInOrder = (keys: string[]) => ({
      type: "object",
      properties: Object.fromEntries(keys.map((key) => [key, { type: "string", description: key === "a" ? "b,c" : "c" }])),
    })
    const before = toolListSide([rawTool()])

    const result = planReview([
      changedFile("a.json", before, toolListSide([rawTool({ inputSchema: schemaInOrder(["a", "a,b"]) })])),
      changedFile("b.json", before, toolListSide([rawTool({ inputSchema: schemaInOrder(["a,b", "a"]) })])),
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 1,
      files: [plannedFile("a.json", ["list_notes"])],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("drops a new file's tools that a changed file with a base already ships", () => {
    const shipped = toolListSide([rawTool({ description: "List every note." })])
    const modified = changedFile("default.json", toolListSide([rawTool()]), shipped)
    const newFile = changedFile("new.json", ABSENT, shipped)

    assert.deepStrictEqual(summarize(planReview([modified, newFile])), {
      records: 1,
      files: [plannedFile("default.json", ["list_notes"])],
      ...NO_PLAN_FINDINGS,
      filesWithNoToolChange: ["new.json"],
    })
  })

  it("reviews a definition shared by two new files once, with no base", () => {
    const newSide = toolListSide([rawTool({ name: "sync_status" })])

    assert.deepStrictEqual(summarize(planReview([changedFile("a.json", ABSENT, newSide), changedFile("b.json", ABSENT, newSide)])), {
      records: 1,
      files: [plannedFile("a.json", ["sync_status"], { base: null })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("drops a new file's tool that a changed file with a base ships unchanged, and reviews the tool it words differently", () => {
    const readNote = rawTool({ name: "read_note", description: "Read a note." })
    const modified = changedFile(
      "default.json",
      toolListSide([rawTool(), readNote]),
      toolListSide([rawTool({ description: "List every note." }), readNote]),
    )
    const newFile = changedFile("readonly.json", ABSENT, toolListSide([readNote, rawTool({ description: "List notes, read-only." })]))

    assert.deepStrictEqual(summarize(planReview([modified, newFile])), {
      records: 2,
      files: [plannedFile("default.json", ["list_notes"]), plannedFile("readonly.json", ["list_notes"], { base: null })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("reviews every tool of an added file that no changed file with a base ships", () => {
    const added = changedFile("copy.json", ABSENT, toolListSide([rawTool()]))

    assert.deepStrictEqual(summarize(planReview([added])), {
      records: 1,
      files: [plannedFile("copy.json", ["list_notes"], { base: null })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("bases a renamed file on its old path", () => {
    const renamed: ChangedFile = {
      ...changedFile("renamed.json", toolListSide([rawTool()]), toolListSide([rawTool({ description: "List every note." })])),
      fromPath: "original.json",
    }

    assert.deepStrictEqual(summarize(planReview([renamed])), {
      records: 1,
      files: [plannedFile("renamed.json", ["list_notes"], { base: { kind: "fromCopy", path: "original.json" } })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("reports removed, broken, not-a-tool-list, and unchanged files and removed tools, without dispatching them", () => {
    const toolList = toolListSide([rawTool()])
    const sectionsOnly = changedFile("sections.json", toolListSide([rawTool()], { instructions: "a" }), toolListSide([rawTool()], { instructions: "b" }))
    const keyOrderOnly = changedFile(
      "order.json",
      toolListSide([rawTool({ inputSchema: { type: "object", properties: {} } })]),
      toolListSide([rawTool({ inputSchema: { properties: {}, type: "object" } })]),
    )
    const lostTool = changedFile("lost.json", toolListSide([rawTool(), rawTool({ name: "read_note" })]), toolList)

    const result = planReview([
      changedFile("deleted.json", toolList, ABSENT),
      changedFile("broken.json", toolList, notToolListSide("broken.json")),
      changedFile("package.json", notToolListSide("package.json"), notToolListSide("package.json")),
      sectionsOnly,
      keyOrderOnly,
      lostTool,
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 0,
      files: [],
      filesWithNoToolChange: ["sections.json", "order.json"],
      broken: [{ path: "broken.json", reason: "broken.json: not a tool list" }],
      removed: [{ path: "deleted.json", tools: ["list_notes"] }],
      removedTools: [{ path: "lost.json", tools: ["read_note"] }],
      addedThenDropped: [],
      notToolLists: ["package.json"],
    })
  })

  it("lists an added or deleted JSON file that is not a tool list as not a tool list", () => {
    const result = planReview([
      changedFile("added.json", ABSENT, notToolListSide("added.json")),
      changedFile("deleted.json", notToolListSide("deleted.json"), ABSENT),
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      notToolLists: ["added.json", "deleted.json"],
    })
  })

  const changedToolsFile = (count: number) => {
    const names = Array.from({ length: count }, (_, index) => `tool_${index + 1}`)
    const before = toolListSide(names.map((name) => rawTool({ name })))
    const after = toolListSide(names.map((name) => rawTool({ name, description: "Changed." })))
    return { names, file: changedFile("default.json", before, after) }
  }

  it("keeps eight reviews in one file as a single dispatch", () => {
    const { names, file } = changedToolsFile(8)

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 8,
      files: [plannedFile("default.json", names)],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("splits more than eight reviews in one file into a cold dispatch and batches of eight", () => {
    const { names, file } = changedToolsFile(9)

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 9,
      files: [plannedFile("default.json", names, { coldDispatch: true, batches: [names.slice(0, 8), names.slice(8)] })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("orders files by review count, then by path in code-unit order", () => {
    const before = toolListSide([rawTool(), rawTool({ name: "read_note" })])
    const changeOne = (description: string) => toolListSide([rawTool({ description }), rawTool({ name: "read_note" })])
    const changeBoth = toolListSide([rawTool({ description: "Z." }), rawTool({ name: "read_note", description: "Read." })])

    const result = planReview([
      changedFile("b.json", before, changeOne("B.")),
      changedFile("a.json", before, changeOne("A.")),
      changedFile("B.json", before, changeOne("Upper.")),
      changedFile("z.json", before, changeBoth),
    ])

    assert.deepStrictEqual(
      result.files.map(({ path }) => path),
      ["z.json", "B.json", "a.json", "b.json"],
    )
  })
})

describe("decideSince", () => {
  const version = (description: string) => parsedTool({ description })
  const [mergeBaseText, reviewedText, laterText, baseBranchText] = [
    version("Merge base."),
    version("Reviewed."),
    version("Edited after review."),
    version("Base branch edit."),
  ]

  it("leaves out a tool the branch never touched, even when the base branch changed it", () => {
    assert.deepStrictEqual(
      decideSince({ since: mergeBaseText, sinceFrom: mergeBaseText, from: baseBranchText, to: baseBranchText }),
      { inScope: false },
    )
  })

  it("compares an edit after the review with the reviewed text", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: mergeBaseText, from: mergeBaseText, to: laterText }), {
      inScope: true,
      base: reviewedText,
      alsoChangedOnBaseBranch: false,
    })
  })

  it("compares a tool reverted to its merge-base wording after the review with the reviewed text", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: mergeBaseText, from: mergeBaseText, to: mergeBaseText }), {
      inScope: true,
      base: reviewedText,
      alsoChangedOnBaseBranch: false,
    })
  })

  it("compares an edit after the review on a tool the change added with the reviewed text", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: undefined, from: undefined, to: laterText }), {
      inScope: true,
      base: reviewedText,
      alsoChangedOnBaseBranch: false,
    })
  })

  it("compares a tool first touched after a merge with the new merge base", () => {
    assert.deepStrictEqual(decideSince({ since: mergeBaseText, sinceFrom: mergeBaseText, from: baseBranchText, to: laterText }), {
      inScope: true,
      base: baseBranchText,
      alsoChangedOnBaseBranch: true,
    })
  })

  it("compares a merge that kept the branch's text over a base-branch edit with the new merge base", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: mergeBaseText, from: baseBranchText, to: reviewedText }), {
      inScope: true,
      base: baseBranchText,
      alsoChangedOnBaseBranch: true,
    })
  })

  it("marks a tool both sides changed and keeps the reviewed text as its base", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: mergeBaseText, from: baseBranchText, to: laterText }), {
      inScope: true,
      base: reviewedText,
      alsoChangedOnBaseBranch: true,
    })
  })

  it("leaves out a tool unchanged since the review when the base branch did not move", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: mergeBaseText, from: mergeBaseText, to: reviewedText }), {
      inScope: false,
    })
  })

  it("leaves out a tool unchanged since the review when the base branch landed the reviewed text", () => {
    assert.deepStrictEqual(decideSince({ since: reviewedText, sinceFrom: mergeBaseText, from: reviewedText, to: reviewedText }), {
      inScope: false,
    })
  })
})

describe("planReview since a review", () => {
  const listNotes = (description: string) => rawTool({ description })
  const readNote = (description: string) => rawTool({ name: "read_note", description })

  it("composes a base from the reviewed text for in-scope tools and the current text for the rest", () => {
    const search = (description: string) => rawTool({ name: "search", description })
    const file = sinceFile("default.json", {
      since: toolListSide([listNotes("Reviewed."), readNote("Read."), search("Search.")], { instructions: "old" }),
      sinceFrom: toolListSide([listNotes("Merge base."), readNote("Read."), search("Search.")], { instructions: "old" }),
      from: toolListSide([listNotes("Merge base."), readNote("Read."), search("Search, edited on main.")], { instructions: "old" }),
      to: toolListSide(
        [listNotes("Edited after review."), readNote("Read, edited."), search("Search, edited on main.")],
        { instructions: "new" },
      ),
    })

    const composedBase = {
      kind: "composed",
      path: "default.json",
      tools: [
        parsedTool({ description: "Reviewed." }),
        parsedTool({ name: "read_note", description: "Read." }),
        parsedTool({ name: "search", description: "Search, edited on main." }),
      ],
      sections: { instructions: "new" },
    }

    assert.deepStrictEqual(planReview([file]), {
      records: 2,
      files: [plannedFile("default.json", ["list_notes", "read_note"], { base: composedBase })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("leaves a tool added since the review out of the composed base, so the reviewer sees it as added", () => {
    const unchanged = toolListSide([listNotes("List.")])
    const file = sinceFile("default.json", {
      since: unchanged,
      sinceFrom: unchanged,
      from: unchanged,
      to: toolListSide([listNotes("List."), readNote("Added after the review.")]),
    })

    const composedBase = { kind: "composed", path: "default.json", tools: [parsedTool({ description: "List." })], sections: {} }

    assert.deepStrictEqual(planReview([file]), {
      records: 1,
      files: [plannedFile("default.json", ["read_note"], { base: composedBase })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("leaves out a tool another pull request changed on the base branch", () => {
    const file = sinceFile("default.json", {
      since: toolListSide([listNotes("Reviewed."), readNote("Read.")]),
      sinceFrom: toolListSide([listNotes("Merge base."), readNote("Read.")]),
      from: toolListSide([listNotes("Merge base."), readNote("Read, edited on main.")]),
      to: toolListSide([listNotes("Reviewed."), readNote("Read, edited on main.")]),
    })

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      filesWithNoToolChange: ["default.json"],
    })
  })

  it("lists a tool added, reviewed, and removed as added then dropped, and keeps a base-branch removal out", () => {
    const file = sinceFile("default.json", {
      since: toolListSide([listNotes("List."), readNote("Added by the branch."), rawTool({ name: "old_tool" })]),
      sinceFrom: toolListSide([listNotes("List."), rawTool({ name: "old_tool" })]),
      from: toolListSide([listNotes("List.")]),
      to: toolListSide([listNotes("List.")]),
    })

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      addedThenDropped: [{ path: "default.json", tools: ["read_note"] }],
    })
  })

  it("lists a reviewed tool that is gone as removed, even when the base branch deleted it after the branch edited it", () => {
    const search = rawTool({ name: "search", description: "Search." })
    const file = sinceFile("default.json", {
      since: toolListSide([listNotes("List."), readNote("Edited by the branch."), search]),
      sinceFrom: toolListSide([listNotes("List."), readNote("Read."), search]),
      from: toolListSide([listNotes("List."), search]),
      to: toolListSide([listNotes("List.")]),
    })

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      removedTools: [{ path: "default.json", tools: ["read_note", "search"] }],
    })
  })

  it("lists a file added, reviewed, and deleted as added then dropped", () => {
    const file = sinceFile("branch-only.json", {
      since: toolListSide([listNotes("List.")]),
      sinceFrom: ABSENT,
      from: ABSENT,
      to: ABSENT,
    })

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      addedThenDropped: [{ path: "branch-only.json", tools: ["list_notes"] }],
    })
  })

  it("keeps a file the base branch deleted and the branch never touched out of the plan", () => {
    const side = toolListSide([listNotes("List.")])
    const file = sinceFile("retired.json", { since: side, sinceFrom: side, from: ABSENT, to: ABSENT })

    assert.deepStrictEqual(summarize(planReview([file])), { records: 0, files: [], ...NO_PLAN_FINDINGS })
  })

  it("reports a file the branch edited and the base branch deleted as removed", () => {
    const file = sinceFile("default.json", {
      since: toolListSide([listNotes("Edited by the branch.")]),
      sinceFrom: toolListSide([listNotes("Merge base.")]),
      from: ABSENT,
      to: ABSENT,
    })

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      removed: [{ path: "default.json", tools: ["list_notes"] }],
    })
  })

  it("reports deleted, broken, and not-a-tool-list files since the review without dispatching them", () => {
    const toolList = toolListSide([listNotes("List.")])
    const reviewedToolList = (path: string, to: FileSide) => {
      return sinceFile(path, { since: toolList, sinceFrom: toolList, from: toolList, to })
    }
    const reviewedNotToolList = (path: string, to: FileSide) => {
      const side = notToolListSide(path)
      return sinceFile(path, { since: side, sinceFrom: side, from: side, to })
    }

    const result = planReview([
      reviewedToolList("deleted.json", ABSENT),
      reviewedToolList("broken.json", notToolListSide("broken.json")),
      reviewedNotToolList("package.json", notToolListSide("package.json")),
      reviewedNotToolList("settings.json", ABSENT),
    ])

    assert.deepStrictEqual(summarize(result), {
      records: 0,
      files: [],
      ...NO_PLAN_FINDINGS,
      broken: [{ path: "broken.json", reason: "broken.json: not a tool list" }],
      removed: [{ path: "deleted.json", tools: ["list_notes"] }],
      notToolLists: ["package.json", "settings.json"],
    })
  })

  it("reviews a file the branch added after the review with no base", () => {
    const file = sinceFile("new.json", { since: ABSENT, sinceFrom: ABSENT, from: ABSENT, to: toolListSide([listNotes("List.")]) })

    assert.deepStrictEqual(summarize(planReview([file])), {
      records: 1,
      files: [plannedFile("new.json", ["list_notes"], { base: null })],
      ...NO_PLAN_FINDINGS,
    })
  })

  it("compares a file the base branch added after the review with the new merge base", () => {
    const file = sinceFile("late.json", {
      since: ABSENT,
      sinceFrom: ABSENT,
      from: toolListSide([listNotes("Merge base.")]),
      to: toolListSide([listNotes("Edited after review.")]),
    })

    const composedBase = { kind: "composed", path: "late.json", tools: [parsedTool({ description: "Merge base." })], sections: {} }

    assert.deepStrictEqual(planReview([file]), {
      records: 1,
      files: [plannedFile("late.json", ["list_notes"], { base: composedBase })],
      ...NO_PLAN_FINDINGS,
    })
  })
})

describe("--plan on a git repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "surface-diff-plan-test-"))
  after(() => rmSync(directory, { recursive: true, force: true }))

  // An empty global and system config, so neither this machine's nor a CI runner's settings change the commits.
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const GIT_IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"]

  const git = (repo: string, args: string[]): string => {
    const { status, stdout, stderr } = spawnSync("git", ["-C", repo, ...GIT_IDENTITY, ...args], { encoding: "utf8", env: GIT_ENV })

    if (status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
    }

    return stdout.trim()
  }

  const makeRepo = (name: string): string => {
    const repo = join(directory, name)
    mkdirSync(repo)
    git(repo, ["init", "-q", "-b", "main"])
    return repo
  }

  /** Writes each file (null deletes it), commits, and returns the commit. */
  const commit = (repo: string, files: Record<string, string | null>): string => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        git(repo, ["rm", "-q", path])
        continue
      }

      writeFileSync(join(repo, path), content)
      git(repo, ["add", path])
    }

    git(repo, ["commit", "-q", "--allow-empty", "-m", "change"])
    return git(repo, ["rev-parse", "HEAD"])
  }

  const surfaceText = (tools: unknown[]) => `${JSON.stringify({ tools }, null, 2)}\n`

  const runPlan = (args: string[]) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT_PATH, "--plan", ...args], { encoding: "utf8" })
    return { status, stdout, stderr }
  }

  /** Every file the plan wrote, as sorted paths relative to `out`. */
  const filesUnder = (out: string): string[] => {
    return readdirSync(out, { recursive: true, encoding: "utf8" })
      .filter((entry) => statSync(join(out, entry)).isFile())
      .toSorted()
  }

  it("writes both sides of a changed tool list and points the plan at them", () => {
    const repo = makeRepo("modified")
    const from = commit(repo, { "default.json": surfaceText([rawTool()]), "package.json": "{}\n" })
    const to = commit(repo, { "default.json": surfaceText([rawTool({ description: "List every note." })]), "package.json": '{"a":1}\n' })
    const out = join(directory, "modified-plan")

    const { status, stdout, stderr } = runPlan(["--repo", repo, "--from", from, "--to", to, "--out", out])
    const plan = JSON.parse(stdout)

    assert.deepStrictEqual(
      { status, stderr, plan },
      {
        status: 0,
        stderr: "",
        plan: {
          mode: "full",
          from,
          to,
          since: null,
          sinceFrom: null,
          out,
          records: 1,
          files: [
            {
              path: "default.json",
              current: join(out, "to", "default.json"),
              base: join(out, "from", "default.json"),
              reviewOnly: ["list_notes"],
              withRoot: true,
              coldDispatch: false,
              batches: [["list_notes"]],
              alsoChangedOnBaseBranch: [],
            },
          ],
          ...NO_PLAN_FINDINGS,
          notToolLists: ["package.json"],
        },
      },
    )

    assert.deepStrictEqual(
      {
        written: filesUnder(out),
        fromCopy: readFileSync(join(out, "from", "default.json"), "utf8"),
        toCopy: readFileSync(join(out, "to", "default.json"), "utf8"),
      },
      {
        written: ["from/default.json", "to/default.json"],
        fromCopy: surfaceText([rawTool()]),
        toCopy: surfaceText([rawTool({ description: "List every note." })]),
      },
    )
  })

  it("copies only the tool lists the plan names, not one whose tools did not change", () => {
    const repo = makeRepo("unnamed")
    const withInstructions = (instructions: string) => `${JSON.stringify({ instructions, tools: [rawTool()] }, null, 2)}\n`
    const from = commit(repo, { "default.json": surfaceText([rawTool()]), "other.json": withInstructions("Old.") })
    const to = commit(repo, {
      "default.json": surfaceText([rawTool({ description: "List every note." })]),
      "other.json": withInstructions("New."),
    })
    const out = join(directory, "unnamed-plan")

    const plan = JSON.parse(runPlan(["--repo", repo, "--from", from, "--to", to, "--out", out]).stdout)

    assert.deepStrictEqual(
      { filesWithNoToolChange: plan.filesWithNoToolChange, written: filesUnder(out) },
      { filesWithNoToolChange: ["other.json"], written: ["from/default.json", "to/default.json"] },
    )
  })

  it("reports a tool list that is no longer valid JSON as broken", () => {
    const repo = makeRepo("unparsable")
    const from = commit(repo, { "default.json": surfaceText([rawTool()]) })
    const to = commit(repo, { "default.json": "{ not json\n" })
    const out = join(directory, "unparsable-plan")

    const { status, stdout, stderr } = runPlan(["--repo", repo, "--from", from, "--to", to, "--out", out])

    assert.deepStrictEqual(
      { status, stderr, plan: JSON.parse(stdout) },
      {
        status: 0,
        stderr: "",
        plan: {
          mode: "full",
          from,
          to,
          since: null,
          sinceFrom: null,
          out,
          records: 0,
          files: [],
          ...NO_PLAN_FINDINGS,
          broken: [{ path: "default.json", reason: "default.json: not valid JSON" }],
        },
      },
    )
  })

  it("bases a renamed tool list on its old path", () => {
    const repo = makeRepo("renamed")
    const tools = Array.from({ length: 6 }, (_, index) => rawTool({ name: `tool_${index}`, description: `Tool ${index} does a thing.` }))
    const from = commit(repo, { "old.json": surfaceText(tools) })
    git(repo, ["mv", "old.json", "new.json"])
    const to = commit(repo, { "new.json": surfaceText([...tools.slice(0, 5), rawTool({ name: "tool_5", description: "Changed." })]) })
    const out = join(directory, "renamed-plan")

    const plan = JSON.parse(runPlan(["--repo", repo, "--from", from, "--to", to, "--out", out]).stdout)

    assert.deepStrictEqual(
      {
        files: plan.files.map(({ path, base, reviewOnly }: { path: string; base: string; reviewOnly: string[] }) => ({ path, base, reviewOnly })),
        baseCopy: readFileSync(join(out, "from", "old.json"), "utf8"),
      },
      {
        files: [{ path: "new.json", base: join(out, "from", "old.json"), reviewOnly: ["tool_5"] }],
        baseCopy: surfaceText(tools),
      },
    )
  })

  it("treats a rename git reports as a delete and an add as a removed file and a new one", () => {
    const repo = makeRepo("replaced")
    // Enough different text that git's similarity check sees a new file, not a rename.
    const otherTools = Array.from({ length: 8 }, (_, index) => {
      return rawTool({ name: `other_${index}`, description: `Other tool ${index} with its own long wording, unlike the old file.` })
    })
    const from = commit(repo, { "old.json": surfaceText([rawTool()]) })
    const to = commit(repo, { "old.json": null, "new.json": surfaceText(otherTools) })
    const out = join(directory, "replaced-plan")

    const plan = JSON.parse(runPlan(["--repo", repo, "--from", from, "--to", to, "--out", out]).stdout)

    assert.deepStrictEqual(
      { removed: plan.removed, files: plan.files.map(({ path, base }: { path: string; base: string | null }) => ({ path, base })) },
      { removed: [{ path: "old.json", tools: ["list_notes"] }], files: [{ path: "new.json", base: null }] },
    )
    assert.deepStrictEqual(git(repo, ["diff", "--name-status", "-M", from, to]).split("\n"), ["A\tnew.json", "D\told.json"])
  })

  it("reads a tool list larger than execFileSync's default 1 MiB buffer", () => {
    const repo = makeRepo("large")
    const longText = "x".repeat(2 * 1024 * 1024)
    const from = commit(repo, { "default.json": surfaceText([rawTool({ description: longText })]) })
    const to = commit(repo, { "default.json": surfaceText([rawTool({ description: `${longText}y` })]) })

    const { status, stdout } = runPlan(["--repo", repo, "--from", from, "--to", to, "--out", join(directory, "large-plan")])

    assert.deepStrictEqual({ status, records: JSON.parse(stdout).records }, { status: 0, records: 1 })
  })

  it("writes the composed base in --since mode", () => {
    const repo = makeRepo("since")
    const mergeBase = commit(repo, { "default.json": surfaceText([rawTool(), rawTool({ name: "read_note" })]) })
    const reviewed = commit(repo, { "default.json": surfaceText([rawTool({ description: "Reviewed." }), rawTool({ name: "read_note" })]) })
    const head = commit(repo, { "default.json": surfaceText([rawTool({ description: "Edited after review." }), rawTool({ name: "read_note" })]) })
    const out = join(directory, "since-plan")

    const args = ["--repo", repo, "--from", mergeBase, "--to", head, "--since", reviewed, "--since-from", mergeBase, "--out", out]
    const { status, stdout, stderr } = runPlan(args)

    assert.deepStrictEqual(
      {
        status,
        stderr,
        plan: JSON.parse(stdout),
        written: filesUnder(out),
        composed: JSON.parse(readFileSync(join(out, "since-base", "default.json"), "utf8")),
      },
      {
        status: 0,
        stderr: "",
        plan: {
          mode: "since",
          from: mergeBase,
          to: head,
          since: reviewed,
          sinceFrom: mergeBase,
          out,
          records: 1,
          files: [
            {
              path: "default.json",
              current: join(out, "to", "default.json"),
              base: join(out, "since-base", "default.json"),
              reviewOnly: ["list_notes"],
              withRoot: true,
              coldDispatch: false,
              batches: [["list_notes"]],
              alsoChangedOnBaseBranch: [],
            },
          ],
          ...NO_PLAN_FINDINGS,
        },
        written: ["since-base/default.json", "to/default.json"],
        composed: {
          tools: [
            { name: "list_notes", description: "Reviewed.", inputSchema: emptySchema() },
            { name: "read_note", description: "List notes.", inputSchema: emptySchema() },
          ],
        },
      },
    )
  })

  it("bases a file renamed after the review on its reviewed copy at the old path", () => {
    const repo = makeRepo("since-renamed")
    const tools = Array.from({ length: 6 }, (_, index) => rawTool({ name: `tool_${index}`, description: `Tool ${index} does a thing.` }))
    const reviewedTools = [...tools.slice(0, 5), rawTool({ name: "tool_5", description: "Reviewed." })]
    const mergeBase = commit(repo, { "old.json": surfaceText(tools) })
    const reviewed = commit(repo, { "old.json": surfaceText(reviewedTools) })
    git(repo, ["mv", "old.json", "new.json"])
    const head = commit(repo, { "new.json": surfaceText([...tools.slice(0, 5), rawTool({ name: "tool_5", description: "Edited after review." })]) })
    const out = join(directory, "since-renamed-plan")

    const args = ["--repo", repo, "--from", mergeBase, "--to", head, "--since", reviewed, "--since-from", mergeBase, "--out", out]
    const plan = JSON.parse(runPlan(args).stdout)
    const composed = JSON.parse(readFileSync(join(out, "since-base", "new.json"), "utf8"))

    assert.deepStrictEqual(
      { reviewOnly: plan.files[0]?.reviewOnly, composed },
      { reviewOnly: ["tool_5"], composed: { tools: reviewedTools } },
    )
  })

  it("reviews only the branch's later edit in a file renamed before the review, after a merge brought in a base-branch edit", () => {
    const repo = makeRepo("since-renamed-before")
    const tools = Array.from({ length: 6 }, (_, index) => rawTool({ name: `tool_${index}`, description: `Tool ${index} does a thing.` }))
    const reword = (list: typeof tools, index: number, description: string) => list.with(index, rawTool({ name: `tool_${index}`, description }))
    const branchTools = reword(tools, 0, "Edited by the branch.")
    const mergedTools = reword(branchTools, 1, "Edited on main.")

    const mergeBase = commit(repo, { "old.json": surfaceText(tools) })
    git(repo, ["switch", "-q", "-c", "feature"])
    git(repo, ["mv", "old.json", "new.json"])
    const reviewed = commit(repo, { "new.json": surfaceText(branchTools) })
    git(repo, ["switch", "-q", "main"])
    const newMergeBase = commit(repo, { "old.json": surfaceText(reword(tools, 1, "Edited on main.")) })
    git(repo, ["switch", "-q", "feature"])
    git(repo, ["merge", "-q", "--no-edit", "main"])
    // The merge must carry main's edit into the renamed file, or the base branch's change never reaches the plan.
    const merged = JSON.parse(git(repo, ["show", "HEAD:new.json"]))
    const head = commit(repo, { "new.json": surfaceText(reword(mergedTools, 2, "Edited after the review.")) })
    const out = join(directory, "since-renamed-before-plan")

    const args = ["--repo", repo, "--from", newMergeBase, "--to", head, "--since", reviewed, "--since-from", mergeBase, "--out", out]
    const plan = JSON.parse(runPlan(args).stdout)

    assert.deepStrictEqual(
      {
        merged,
        files: plan.files.map(({ path, reviewOnly, alsoChangedOnBaseBranch }: Record<string, unknown>) => ({ path, reviewOnly, alsoChangedOnBaseBranch })),
        removed: plan.removed,
      },
      {
        merged: { tools: mergedTools },
        files: [{ path: "new.json", reviewOnly: ["tool_2"], alsoChangedOnBaseBranch: [] }],
        removed: [],
      },
    )
  })

  it("reviews a tool a merge kept at the reviewed text over a base-branch edit, against the base branch's text", () => {
    const repo = makeRepo("since-merge-kept")
    const toolsWith = (description: string) => surfaceText([rawTool({ description }), rawTool({ name: "read_note" })])

    const mergeBase = commit(repo, { "default.json": toolsWith("Merge base.") })
    git(repo, ["switch", "-q", "-c", "feature"])
    const reviewed = commit(repo, { "default.json": toolsWith("Reviewed.") })
    git(repo, ["switch", "-q", "main"])
    const newMergeBase = commit(repo, { "default.json": toolsWith("Base branch edit.") })
    git(repo, ["switch", "-q", "feature"])
    git(repo, ["merge", "-q", "--no-edit", "-X", "ours", "main"])
    const head = git(repo, ["rev-parse", "HEAD"])
    const out = join(directory, "since-merge-kept-plan")

    const args = ["--repo", repo, "--from", newMergeBase, "--to", head, "--since", reviewed, "--since-from", mergeBase, "--out", out]
    const plan = JSON.parse(runPlan(args).stdout)

    assert.deepStrictEqual(
      {
        // The head must hold the reviewed text, so only the base branch's change can bring the file into the plan.
        changedSinceReview: git(repo, ["diff", "--name-only", reviewed, head]),
        files: plan.files,
        composed: JSON.parse(readFileSync(join(out, "since-base", "default.json"), "utf8")),
      },
      {
        changedSinceReview: "",
        files: [
          {
            path: "default.json",
            current: join(out, "to", "default.json"),
            base: join(out, "since-base", "default.json"),
            reviewOnly: ["list_notes"],
            withRoot: true,
            coldDispatch: false,
            batches: [["list_notes"]],
            alsoChangedOnBaseBranch: ["list_notes"],
          },
        ],
        composed: {
          tools: [
            { name: "list_notes", description: "Base branch edit.", inputSchema: emptySchema() },
            { name: "read_note", description: "List notes.", inputSchema: emptySchema() },
          ],
        },
      },
    )
  })

  it("reads from the top of the repository when --repo names a folder inside it", () => {
    const repo = makeRepo("inner-folder")
    mkdirSync(join(repo, "inner"))
    const from = commit(repo, { "default.json": surfaceText([rawTool()]) })
    const to = commit(repo, { "default.json": surfaceText([rawTool({ description: "List every note." })]) })

    const plan = JSON.parse(runPlan(["--repo", join(repo, "inner"), "--from", from, "--to", to, "--out", join(directory, "inner-plan")]).stdout)

    assert.deepStrictEqual(
      plan.files.map(({ path, reviewOnly }: { path: string; reviewOnly: string[] }) => ({ path, reviewOnly })),
      [{ path: "default.json", reviewOnly: ["list_notes"] }],
    )
  })

  it("exits 2 on a path that climbs out of the repository, and writes nothing", () => {
    const repo = makeRepo("climbing-path")
    const from = commit(repo, { "default.json": surfaceText([rawTool()]) })

    // Git refuses to stage a ".." entry, but a hand-built tree can hold one, and git diff lists the path it makes.
    const writeObject = (args: string[], input: string): string => {
      const { status, stdout, stderr } = spawnSync("git", ["-C", repo, ...args], { input, encoding: "utf8", env: GIT_ENV })

      if (status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
      }

      return stdout.trim()
    }
    const plantedBlob = writeObject(["hash-object", "-w", "--stdin"], surfaceText([rawTool({ name: "planted" })]))
    const innerTree = writeObject(["mktree"], `100644 blob ${plantedBlob}\tplanted.json\n`)
    const climbingTree = writeObject(["mktree"], `040000 tree ${innerTree}\t..\n`)
    const defaultBlob = git(repo, ["rev-parse", `${from}:default.json`])
    const rootTree = writeObject(["mktree"], `100644 blob ${defaultBlob}\tdefault.json\n040000 tree ${climbingTree}\t..\n`)
    const to = git(repo, ["commit-tree", rootTree, "-p", from, "-m", "climb"])

    // The plan's own folder sits one level down, so "to/../../planted.json" would land beside it.
    const parent = join(directory, "climbing-plan")
    mkdirSync(parent)
    const out = join(parent, "plan")

    const { status, stdout, stderr } = runPlan(["--repo", repo, "--from", from, "--to", to, "--out", out])

    assert.deepStrictEqual(
      {
        listedPath: git(repo, ["diff", "--name-only", from, to, "--", "*.json"]),
        status,
        stdout,
        namesPath: stderr.includes("../../planted.json"),
        planWritten: existsSync(out),
        plantedWritten: existsSync(join(parent, "planted.json")),
      },
      { listedPath: "../../planted.json", status: 2, stdout: "", namesPath: true, planWritten: false, plantedWritten: false },
    )
  })

  it("exits 2 when --out already exists", () => {
    const repo = makeRepo("existing-out")
    const head = commit(repo, { "default.json": surfaceText([rawTool()]) })
    const out = mkdtempSync(join(directory, "existing-"))

    assert.deepStrictEqual(runPlan(["--repo", repo, "--from", head, "--to", head, "--out", out]), {
      status: 2,
      stdout: "",
      stderr: `${out}: already exists; --out must name a new folder\n`,
    })
  })

  it("exits 2 when --out's parent folder is missing", () => {
    const repo = makeRepo("missing-parent")
    const head = commit(repo, { "default.json": surfaceText([rawTool()]) })
    const out = join(directory, "no-such-parent", "plan")

    assert.deepStrictEqual(runPlan(["--repo", repo, "--from", head, "--to", head, "--out", out]), {
      status: 2,
      stdout: "",
      stderr: `${out}: its parent folder does not exist\n`,
    })
  })

  it("exits 2 when a ref is not a commit", () => {
    const repo = makeRepo("unknown-ref")
    const head = commit(repo, { "default.json": surfaceText([rawTool()]) })

    assert.deepStrictEqual(runPlan(["--repo", repo, "--from", "no-such-ref", "--to", head, "--out", join(directory, "unknown-plan")]), {
      status: 2,
      stdout: "",
      stderr: `no-such-ref: not a commit in ${repo}\n`,
    })
  })
})
