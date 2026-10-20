import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { buildClaudeArgs, summarizeEvents } from "../run-plugin-headless.ts"

const SCRIPT_PATH = fileURLToPath(new URL("../run-plugin-headless.ts", import.meta.url))

const USAGE = [
  "Usage: run-plugin-headless.ts --plugin <name> --cwd <dir> --prompt <file> --out <new file>",
  "         [--allow <tool> ...] [--model <model>] [--checkout <dir>]",
].join("\n")

const HEADLESS_NOTE =
  "This is a headless test run of a plugin from a scratch checkout. Do only what the prompt asks: do not start any routine your instructions run at session start, do not edit task boards or logs, and do not message other sessions."

const expectedClaudeArgs = ({
  pluginDir,
  settings,
  allowed,
  model = "opus",
}: {
  pluginDir: string
  settings: string
  allowed: string[]
  model?: string
}) => [
  "-p",
  "--model",
  model,
  "--plugin-dir",
  pluginDir,
  "--setting-sources",
  "user,local",
  "--settings",
  settings,
  "--append-system-prompt",
  HEADLESS_NOTE,
  ...allowed,
  "--output-format",
  "stream-json",
  "--verbose",
]

describe("buildClaudeArgs", () => {
  it("loads the checkout's plugin with the given model, turns off the installed copy and every hook, and lists the allowed tools", () => {
    const args = buildClaudeArgs({
      pluginDir: "/checkout/plugins/demo",
      installedPluginKey: "demo@demo-market",
      model: "sonnet",
      allowedTools: ["Agent", "Bash(git *)"],
    })

    assert.deepStrictEqual(
      args,
      expectedClaudeArgs({
        pluginDir: "/checkout/plugins/demo",
        settings: '{"enabledPlugins":{"demo@demo-market":false},"disableAllHooks":true}',
        allowed: ["--allowedTools", "Agent", "Bash(git *)"],
        model: "sonnet",
      }),
    )
  })

  it("leaves out --allowedTools when no tool is allowed", () => {
    const args = buildClaudeArgs({
      pluginDir: "/checkout/plugins/demo",
      installedPluginKey: "demo@demo-market",
      model: "opus",
      allowedTools: [],
    })

    assert.deepStrictEqual(
      args,
      expectedClaudeArgs({
        pluginDir: "/checkout/plugins/demo",
        settings: '{"enabledPlugins":{"demo@demo-market":false},"disableAllHooks":true}',
        allowed: [],
      }),
    )
  })
})

describe("summarizeEvents", () => {
  it("reads the model and plugins from the init event and the outcome from the last result event", () => {
    const stream = [
      '{"type":"system","subtype":"init","model":"claude-opus-5-5","plugins":[{"name":"demo","path":"/checkout/plugins/demo"}]}',
      '{"type":"assistant","message":{"content":[]}}',
      "a line that is not JSON",
      '{"type":"result","is_error":true,"result":"first","num_turns":1}',
      "",
      '{"type":"result","is_error":false,"result":"done","num_turns":4,"total_cost_usd":1.25,"permission_denials":[{"tool_name":"Write"}]}',
    ].join("\n")

    assert.deepStrictEqual(summarizeEvents(stream), {
      model: "claude-opus-5-5",
      plugins: [{ name: "demo", path: "/checkout/plugins/demo" }],
      result: "done",
      isError: false,
      turns: 4,
      costUsd: 1.25,
      permissionDenials: [{ tool_name: "Write" }],
      unparsedLines: 1,
    })
  })

  it("leaves the outcome null when the run stopped before its result event", () => {
    const stream = '{"type":"system","subtype":"init","model":"claude-opus-5-5","plugins":[]}\n'

    assert.deepStrictEqual(summarizeEvents(stream), {
      model: "claude-opus-5-5",
      plugins: [],
      result: null,
      isError: null,
      turns: null,
      costUsd: null,
      permissionDenials: null,
      unparsedLines: 0,
    })
  })

  it("counts a JSON line that is not an object as unparsed", () => {
    const stream = [
      '{"type":"system","subtype":"init","model":"claude-opus-5-5","plugins":[]}',
      '[{"type":"result","result":"inside an array"}]',
      "42",
      "null",
      '"a string"',
    ].join("\n")

    assert.deepStrictEqual(summarizeEvents(stream), {
      model: "claude-opus-5-5",
      plugins: [],
      result: null,
      isError: null,
      turns: null,
      costUsd: null,
      permissionDenials: null,
      unparsedLines: 4,
    })
  })

  it("gives null for a field that holds the wrong type", () => {
    const stream = [
      '{"type":"system","subtype":"init","model":5,"plugins":[]}',
      '{"type":"result","is_error":"false","result":7,"num_turns":"4","total_cost_usd":"1.25","permission_denials":[]}',
    ].join("\n")

    assert.deepStrictEqual(summarizeEvents(stream), {
      model: null,
      plugins: [],
      result: null,
      isError: null,
      turns: null,
      costUsd: null,
      permissionDenials: [],
      unparsedLines: 0,
    })
  })
})

describe("command line", () => {
  const directory = mkdtempSync(join(tmpdir(), "run-plugin-headless-test-"))
  after(() => rmSync(directory, { recursive: true, force: true }))

  /** A checkout holding the plugin "demo", with the given marketplace manifest text, or none when it is null. */
  const writeCheckout = (name: string, manifest: string | null): string => {
    const root = join(directory, name)
    mkdirSync(join(root, ".claude-plugin"), { recursive: true })
    if (manifest !== null) writeFileSync(join(root, ".claude-plugin", "marketplace.json"), manifest)
    mkdirSync(join(root, "plugins", "demo", ".claude-plugin"), { recursive: true })
    writeFileSync(join(root, "plugins", "demo", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }))
    return root
  }

  const checkout = writeCheckout("checkout", JSON.stringify({ name: "demo-market" }))
  const project = join(directory, "project")
  const stubBin = join(directory, "bin")
  const promptPath = join(directory, "prompt.md")

  mkdirSync(project)
  writeFileSync(promptPath, "Say hi")

  // Stands in for the claude CLI, so a broken script never starts a real session:
  // - It records its arguments, prints a stream that echoes the prompt it read and the directory it ran in, and exits 3
  //   so the test can see the exit status come through.
  // - The test for a claude that cannot start gives the script a PATH holding only an empty directory instead, and the
  //   test for a run killed by a signal puts a second stub, which kills itself, first on PATH.
  mkdirSync(stubBin)
  writeFileSync(
    join(stubBin, "claude"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "${STUB_ARGS_FILE:-/dev/null}"',
      "prompt=$(cat)",
      'printf \'{"type":"system","subtype":"init","model":"stub-model","plugins":[{"name":"demo"}]}\\n\'',
      "printf 'not an event\\n'",
      'printf \'{"type":"result","is_error":false,"result":"%s in %s","num_turns":2,"total_cost_usd":0.5,"permission_denials":[]}\\n\' "$prompt" "$(pwd -P)"',
      "echo 'stub stderr' >&2",
      "exit 3",
      "",
    ].join("\n"),
  )
  chmodSync(join(stubBin, "claude"), 0o755)

  const stubEnv = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` }

  const runScript = (args: string[], env: NodeJS.ProcessEnv = stubEnv) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8", env })
    return { status, stdout, stderr }
  }

  const requiredArgs = (out: string) => ["--plugin", "demo", "--cwd", project, "--prompt", promptPath, "--out", out]

  it("prints the usage and exits 2 when a required option is missing", () => {
    const { status, stdout, stderr } = runScript(["--plugin", "demo"])

    assert.deepStrictEqual({ status, stdout, stderr }, { status: 2, stdout: "", stderr: `${USAGE}\n` })
  })

  it("exits 2 for a plugin the checkout does not hold", () => {
    const out = join(directory, "missing-plugin.jsonl")
    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out), "--plugin", "absent"])
    const pluginDir = join(checkout, "plugins", "absent")

    assert.deepStrictEqual(
      { status, stdout, stderr },
      { status: 2, stdout: "", stderr: `no plugin named absent: ${pluginDir} has no .claude-plugin/plugin.json\n` },
    )
  })

  it("looks for the plugin in the checkout the script sits in when --checkout is left out", () => {
    const out = join(directory, "default-checkout.jsonl")
    const { status, stdout, stderr } = runScript([...requiredArgs(out), "--plugin", "absent"])
    const pluginDir = resolve(dirname(SCRIPT_PATH), "..", "plugins", "absent")

    assert.deepStrictEqual(
      { status, stdout, stderr },
      { status: 2, stdout: "", stderr: `no plugin named absent: ${pluginDir} has no .claude-plugin/plugin.json\n` },
    )
  })

  it("exits 2 with the parser's message and the usage for an unknown option", () => {
    const { status, stdout, stderr } = runScript(["--bogus"])
    // The first line is the runtime's own parseArgs message, whose wording differs between Bun and Node.
    const [parserMessage, ...rest] = stderr.split("\n")

    assert.deepStrictEqual(
      { status, stdout, namesOption: parserMessage?.includes("'--bogus'"), rest: rest.join("\n") },
      { status: 2, stdout: "", namesOption: true, rest: `${USAGE}\n` },
    )
  })

  it("exits 2 when the checkout has no marketplace manifest", () => {
    const bare = writeCheckout("checkout-without-manifest", null)
    const manifestPath = join(bare, ".claude-plugin", "marketplace.json")
    const out = join(directory, "no-manifest.jsonl")

    const { status, stdout, stderr } = runScript(["--checkout", bare, ...requiredArgs(out)])

    assert.deepStrictEqual(
      { status, stdout, stderr, outCreated: existsSync(out) },
      {
        status: 2,
        stdout: "",
        stderr: `cannot read ${manifestPath}: ENOENT: no such file or directory, open '${manifestPath}'\n`,
        outCreated: false,
      },
    )
  })

  it("exits 2 when the marketplace manifest has no name", () => {
    const unnamed = writeCheckout("checkout-without-name", JSON.stringify({ plugins: [] }))
    const manifestPath = join(unnamed, ".claude-plugin", "marketplace.json")
    const out = join(directory, "no-name.jsonl")

    const { status, stdout, stderr } = runScript(["--checkout", unnamed, ...requiredArgs(out)])

    assert.deepStrictEqual(
      { status, stdout, stderr, outCreated: existsSync(out) },
      { status: 2, stdout: "", stderr: `${manifestPath} has no "name" field\n`, outCreated: false },
    )
  })

  for (const { label, cwd } of [
    { label: "does not exist", cwd: join(directory, "absent-project") },
    { label: "is a file", cwd: promptPath },
  ]) {
    it(`exits 2 when --cwd ${label}`, () => {
      const out = join(directory, `cwd-${label.replaceAll(" ", "-")}.jsonl`)

      const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out), "--cwd", cwd])

      assert.deepStrictEqual(
        { status, stdout, stderr, outCreated: existsSync(out) },
        { status: 2, stdout: "", stderr: `--cwd is not a directory: ${cwd}\n`, outCreated: false },
      )
    })
  }

  it("exits 2 without creating --out when the prompt file cannot be read", () => {
    const missingPrompt = join(directory, "absent-prompt.md")
    const out = join(directory, "no-prompt.jsonl")

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out), "--prompt", missingPrompt])

    assert.deepStrictEqual(
      { status, stdout, stderr, outCreated: existsSync(out) },
      {
        status: 2,
        stdout: "",
        stderr: `cannot read the prompt file: ENOENT: no such file or directory, open '${missingPrompt}'\n`,
        outCreated: false,
      },
    )
  })

  it("exits 2 rather than overwrite an earlier run's output", () => {
    const out = join(directory, "earlier.jsonl")
    writeFileSync(out, "earlier run\n")

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out)])

    assert.deepStrictEqual(
      { status, stdout, stderr, kept: readFileSync(out, "utf8") },
      { status: 2, stdout: "", stderr: `cannot create ${out}: EEXIST: file already exists, open '${out}'\n`, kept: "earlier run\n" },
    )
  })

  it("exits 2 without creating --out when <out>.stderr already exists", () => {
    const out = join(directory, "stderr-taken.jsonl")
    writeFileSync(`${out}.stderr`, "earlier run\n")

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out)])

    assert.deepStrictEqual(
      { status, stdout, stderr, outCreated: existsSync(out) },
      {
        status: 2,
        stdout: "",
        stderr: `cannot create ${out}.stderr: EEXIST: file already exists, open '${out}.stderr'\n`,
        outCreated: false,
      },
    )
  })

  it("removes --out again when <out>.stderr cannot be created for another reason", () => {
    // A 249-byte name is one the filesystem accepts, and ".stderr" takes it to 256, past the 255-byte limit on a name,
    // so only the second file fails, and it fails with ENAMETOOLONG rather than EEXIST.
    const out = join(directory, `${"a".repeat(243)}.jsonl`)

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out)])

    assert.deepStrictEqual(
      { status, stdout, stderr, outLeft: existsSync(out) },
      {
        status: 2,
        stdout: "",
        stderr: `cannot create ${out}.stderr: ENAMETOOLONG: name too long, open '${out}.stderr'\n`,
        outLeft: false,
      },
    )
  })

  it("exits 2 and removes both empty files when claude cannot start", () => {
    const out = join(directory, "no-claude.jsonl")
    const emptyBin = mkdtempSync(join(directory, "empty-bin-"))

    const env = { ...process.env, PATH: emptyBin }

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out)], env)

    assert.deepStrictEqual(
      {
        status,
        stdout,
        startError: stderr.startsWith("claude did not start: "),
        outLeft: existsSync(out),
        stderrLeft: existsSync(`${out}.stderr`),
      },
      { status: 2, stdout: "", startError: true, outLeft: false, stderrLeft: false },
    )
  })

  it("runs claude in --cwd with the prompt on standard input, saves both streams, and prints the summary", () => {
    const out = join(directory, "run.jsonl")
    const argsFile = join(directory, "stub-args.txt")
    const env = { ...stubEnv, STUB_ARGS_FILE: argsFile }

    const resolvedClaude = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8", env }).stdout.trim()
    assert.equal(resolvedClaude, join(stubBin, "claude"))

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out), "--allow", "Read"], env)

    assert.deepStrictEqual(
      { status, stderr, summary: JSON.parse(stdout) },
      {
        status: 3,
        stderr: "",
        summary: {
          exitCode: 3,
          out,
          stderr: `${out}.stderr`,
          model: "stub-model",
          plugins: [{ name: "demo" }],
          result: `Say hi in ${realpathSync(project)}`,
          isError: false,
          turns: 2,
          costUsd: 0.5,
          permissionDenials: [],
          unparsedLines: 1,
        },
      },
    )
    assert.equal(readFileSync(`${out}.stderr`, "utf8"), "stub stderr\n")
    assert.deepStrictEqual(
      readFileSync(argsFile, "utf8").split("\n").slice(0, -1),
      expectedClaudeArgs({
        pluginDir: join(checkout, "plugins", "demo"),
        settings: '{"enabledPlugins":{"demo@demo-market":false},"disableAllHooks":true}',
        allowed: ["--allowedTools", "Read"],
      }),
    )
  })

  it("passes --model on to claude", () => {
    const out = join(directory, "model.jsonl")
    const argsFile = join(directory, "model-stub-args.txt")
    const env = { ...stubEnv, STUB_ARGS_FILE: argsFile }

    const { status } = runScript(["--checkout", checkout, ...requiredArgs(out), "--model", "sonnet"], env)

    assert.deepStrictEqual(
      { status, args: readFileSync(argsFile, "utf8").split("\n").slice(0, -1) },
      {
        status: 3,
        args: expectedClaudeArgs({
          pluginDir: join(checkout, "plugins", "demo"),
          settings: '{"enabledPlugins":{"demo@demo-market":false},"disableAllHooks":true}',
          allowed: [],
          model: "sonnet",
        }),
      },
    )
  })

  it("exits 1 and reports a null exit code when a signal kills claude", () => {
    const out = join(directory, "killed.jsonl")
    const killedBin = join(directory, "killed-bin")
    mkdirSync(killedBin)
    writeFileSync(join(killedBin, "claude"), ["#!/bin/sh", "cat > /dev/null", "kill -KILL $$", ""].join("\n"))
    chmodSync(join(killedBin, "claude"), 0o755)

    const env = { ...process.env, PATH: `${killedBin}:${process.env.PATH}` }

    const { status, stdout, stderr } = runScript(["--checkout", checkout, ...requiredArgs(out)], env)

    assert.deepStrictEqual(
      { status, stderr, summary: JSON.parse(stdout) },
      {
        status: 1,
        stderr: "",
        summary: {
          exitCode: null,
          out,
          stderr: `${out}.stderr`,
          model: null,
          plugins: null,
          result: null,
          isError: null,
          turns: null,
          costUsd: null,
          permissionDenials: null,
          unparsedLines: 0,
        },
      },
    )
  })
})
