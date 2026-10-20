import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const expectedClaudeArgs = ({ pluginDir, settings, allowed }: { pluginDir: string; settings: string; allowed: string[] }) => [
  "-p",
  "--model",
  "opus",
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
  it("loads the checkout's plugin, turns off the installed copy and every hook, and lists the allowed tools", () => {
    const args = buildClaudeArgs({
      pluginDir: "/checkout/plugins/demo",
      installedPluginKey: "demo@demo-market",
      model: "opus",
      allowedTools: ["Agent", "Bash(git *)"],
    })

    assert.deepStrictEqual(
      args,
      expectedClaudeArgs({
        pluginDir: "/checkout/plugins/demo",
        settings: '{"enabledPlugins":{"demo@demo-market":false},"disableAllHooks":true}',
        allowed: ["--allowedTools", "Agent", "Bash(git *)"],
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
})

describe("command line", () => {
  const directory = mkdtempSync(join(tmpdir(), "run-plugin-headless-test-"))
  after(() => rmSync(directory, { recursive: true, force: true }))

  const checkout = join(directory, "checkout")
  const project = join(directory, "project")
  const stubBin = join(directory, "bin")
  const promptPath = join(directory, "prompt.md")

  mkdirSync(join(checkout, ".claude-plugin"), { recursive: true })
  writeFileSync(join(checkout, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "demo-market" }))
  mkdirSync(join(checkout, "plugins", "demo", ".claude-plugin"), { recursive: true })
  writeFileSync(join(checkout, "plugins", "demo", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }))
  mkdirSync(project)
  writeFileSync(promptPath, "Say hi")

  // Stands in for the claude CLI, so a broken script never starts a real session:
  // - It records its arguments, prints a stream that echoes the prompt it read and the directory it ran in, and exits 3
  //   so the test can see the exit status come through.
  // - The one test that leaves it off PATH gives the script a PATH holding only an empty directory instead.
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
      {
        status,
        stdout,
        nameTooLong: stderr.startsWith(`cannot create ${out}.stderr: ENAMETOOLONG`),
        outLeft: existsSync(out),
      },
      { status: 2, stdout: "", nameTooLong: true, outLeft: false },
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
})
