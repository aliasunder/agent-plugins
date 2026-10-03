import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
  InputError,
  changedParts,
  commonSubstrings,
  compareSurfaces,
  listVariants,
  parameterTexts,
  parseSurface,
  showTools,
} from "../surface-diff.ts"

const SCRIPT_PATH = fileURLToPath(new URL("../surface-diff.ts", import.meta.url))

const USAGE = [
  "Usage: surface-diff.ts --current <file> [--base <file>] [--names]",
  "       surface-diff.ts --current <file> --variants <file> [--variants <file> ...]",
  "       surface-diff.ts --current <file> --show <tool> [--show <tool> ...]",
].join("\n")

// '{"type":"object","properties":{}}' is 33 characters and "List notes." is 11.
const EMPTY_SCHEMA_CHARS = 33
const LIST_NOTES_CHARS = 11 + EMPTY_SCHEMA_CHARS

const PATHS = { base: "base.json", current: "current.json" }

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

  it("reports which of a snapshot's sections changed", () => {
    const base = surfaceOf([rawTool()], { instructions: "Read first.", prompts: [] })
    const current = surfaceOf([rawTool()], { instructions: "Read this first.", prompts: [] })

    assert.deepStrictEqual(compareSurfaces(base, current, PATHS).sections, [
      { name: "instructions", changed: true },
      { name: "prompts", changed: false },
    ])
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
      stderr: "--show prints tools from --current; it cannot be combined with --base or --variants\n",
    })
  })

  it("exits 2 when --variants is combined with --base", () => {
    const current = writeSurface("combined-current.json", [rawTool()])

    assert.deepStrictEqual(runScript(["--current", current, "--base", current, "--variants", current]), {
      status: 2,
      stdout: "",
      stderr: "--variants lists other configurations; it cannot be combined with --base\n",
    })
  })
})
