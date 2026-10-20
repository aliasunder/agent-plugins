/**
 * Runs Claude Code headless with one of this repository's plugins loaded from a checkout, so a change to its skills
 * or agents can be tried on a real project before it ships. A running session keeps the plugin text it started with;
 * this run reads the checkout's files when it starts.
 */
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

/** Thrown for anything wrong with the arguments or the files they name; the CLI exits 2 on it. */
export class InputError extends Error {}

const USAGE = [
  "Usage: run-plugin-headless.ts --plugin <name> --cwd <dir> --prompt <file> --out <new file>",
  "         [--allow <tool> ...] [--model <model>] [--checkout <dir>]",
].join("\n")

// The checkout this script sits in. --checkout names another one, such as a worktree holding the change.
const DEFAULT_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const DEFAULT_MODEL = "opus"

// The user's own instructions may start a routine at session start (reading notes, messaging other sessions), which
// a test run must not do.
const HEADLESS_NOTE =
  "This is a headless test run of a plugin loaded from a local checkout. Do only what the prompt asks: do not start any routine your instructions run at session start, do not edit task boards or logs, and do not message other sessions."

export type ClaudeRunOptions = {
  pluginDir: string
  // The installed copy's key, `<plugin>@<marketplace>`.
  installedPluginKey: string
  model: string
  allowedTools: readonly string[]
}

/** The claude arguments for one headless run. The prompt goes in on standard input. */
export const buildClaudeArgs = ({ pluginDir, installedPluginKey, model, allowedTools }: ClaudeRunOptions): string[] => {
  const settings = JSON.stringify({
    // Left on, the installed copy would load beside the checkout's copy, with agents of the same names.
    enabledPlugins: { [installedPluginKey]: false },
    // A guard hook written for interactive sessions could block or rewrite the run's tool calls.
    disableAllHooks: true,
  })

  // A headless run has nobody to answer a permission prompt, so it denies a tool that neither this list nor the
  // user's settings allow.
  const allowedToolsArgs = allowedTools.length > 0 ? ["--allowedTools", ...allowedTools] : []

  return [
    "-p",
    "--model",
    model,
    "--plugin-dir",
    pluginDir,
    // Leaves out the project's shared .claude/settings.json, whose hooks and permission rules are not part of the test.
    "--setting-sources",
    "user,local",
    "--settings",
    settings,
    "--append-system-prompt",
    HEADLESS_NOTE,
    ...allowedToolsArgs,
    "--output-format",
    "stream-json",
    "--verbose",
  ]
}

export type RunSummary = {
  model: string | null
  plugins: unknown
  result: string | null
  isError: boolean | null
  turns: number | null
  costUsd: number | null
  permissionDenials: unknown
  unparsedLines: number
}

type JsonObject = Record<string, unknown>

const isJsonObject = (value: unknown): value is JsonObject => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const parseEventLine = (line: string): JsonObject | null => {
  // A line that is not a JSON object, whether it fails to parse or holds an array or a number, gives null.
  // summarizeEvents counts those lines in unparsedLines, so they are reported rather than lost.
  try {
    const parsed: unknown = JSON.parse(line)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const stringField = (event: JsonObject | undefined, key: string): string | null => {
  const value = event?.[key]
  return typeof value === "string" ? value : null
}

const numberField = (event: JsonObject | undefined, key: string): number | null => {
  const value = event?.[key]
  return typeof value === "number" ? value : null
}

const booleanField = (event: JsonObject | undefined, key: string): boolean | null => {
  const value = event?.[key]
  return typeof value === "boolean" ? value : null
}

/**
 * What a run's event stream says: the session's model and plugins from its init event, and the outcome from its last
 * result event. A run that was stopped early has no result event, so its outcome fields are null.
 */
export const summarizeEvents = (stream: string): RunSummary => {
  const lines = stream.split("\n").filter((line) => line.trim() !== "")
  const events = lines.map(parseEventLine).filter((event) => event !== null)

  const init = events.find((event) => event.type === "system" && event.subtype === "init")
  const result = events.findLast((event) => event.type === "result")

  return {
    model: stringField(init, "model"),
    plugins: init?.plugins ?? null,
    result: stringField(result, "result"),
    isError: booleanField(result, "is_error"),
    turns: numberField(result, "num_turns"),
    costUsd: numberField(result, "total_cost_usd"),
    permissionDenials: result?.permission_denials ?? null,
    unparsedLines: lines.length - events.length,
  }
}

const readArguments = (argv: string[]) => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        plugin: { type: "string" },
        cwd: { type: "string" },
        prompt: { type: "string" },
        out: { type: "string" },
        allow: { type: "string", multiple: true },
        model: { type: "string" },
        checkout: { type: "string" },
      },
    })

    return values
  } catch (error) {
    throw new InputError(`${describeError(error)}\n${USAGE}`)
  }
}

const readManifest = (manifestPath: string): unknown => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    throw new InputError(`cannot read ${manifestPath}: ${describeError(error)}`)
  }
}

/** The marketplace name from the checkout's manifest, the part after "@" in an installed plugin's key. */
const readMarketplaceName = (checkout: string): string => {
  const manifestPath = join(checkout, ".claude-plugin", "marketplace.json")
  const manifest = readManifest(manifestPath)
  const name = isJsonObject(manifest) ? manifest.name : undefined

  if (typeof name !== "string") throw new InputError(`${manifestPath} has no "name" field`)
  return name
}

const readPrompt = (promptPath: string): string => {
  try {
    return readFileSync(promptPath, "utf8")
  } catch (error) {
    throw new InputError(`cannot read the prompt file: ${describeError(error)}`)
  }
}

/** Opens a new file for writing. "wx" refuses an existing file, so a run never overwrites an earlier run's output. */
const openNewFile = (path: string): number => {
  try {
    return openSync(path, "wx")
  } catch (error) {
    throw new InputError(`cannot create ${path}: ${describeError(error)}`)
  }
}

/**
 * Creates --out and <out>.stderr as new files. When <out>.stderr cannot be created, --out is closed and removed again:
 * an empty --out left behind would make a retry with the same --out refuse to start.
 */
const openOutputFiles = (outPath: string, stderrPath: string): { outFile: number; stderrFile: number } => {
  const outFile = openNewFile(outPath)

  try {
    return { outFile, stderrFile: openNewFile(stderrPath) }
  } catch (error) {
    closeSync(outFile)
    rmSync(outPath)
    throw error
  }
}

const run = (argv: string[]): number => {
  const { plugin, cwd, prompt, out, allow = [], model = DEFAULT_MODEL, checkout = DEFAULT_CHECKOUT } = readArguments(argv)
  if (!plugin || !cwd || !prompt || !out) throw new InputError(USAGE)

  const pluginDir = resolve(checkout, "plugins", plugin)
  if (!existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) {
    throw new InputError(`no plugin named ${plugin}: ${pluginDir} has no .claude-plugin/plugin.json`)
  }

  const workingDirectory = resolve(cwd)
  if (!existsSync(workingDirectory) || !statSync(workingDirectory).isDirectory()) {
    throw new InputError(`--cwd is not a directory: ${workingDirectory}`)
  }

  const claudeArgs = buildClaudeArgs({
    pluginDir,
    installedPluginKey: `${plugin}@${readMarketplaceName(checkout)}`,
    model,
    allowedTools: allow,
  })
  const promptText = readPrompt(prompt)

  const outPath = resolve(out)
  const stderrPath = `${outPath}.stderr`
  const { outFile, stderrFile } = openOutputFiles(outPath, stderrPath)

  try {
    const child = spawnSync("claude", claudeArgs, {
      cwd: workingDirectory,
      input: promptText,
      stdio: ["pipe", outFile, stderrFile],
    })

    // claude never ran, so both files are empty; removing them lets the retry use the same --out.
    if (child.error) {
      rmSync(outPath)
      rmSync(stderrPath)
      throw new InputError(`claude did not start: ${child.error.message}`)
    }

    const summary = summarizeEvents(readFileSync(outPath, "utf8"))
    console.log(JSON.stringify({ exitCode: child.status, out: outPath, stderr: stderrPath, ...summary }, null, 2))

    // A run killed by a signal has no exit status.
    return child.status ?? 1
  } finally {
    closeSync(outFile)
    closeSync(stderrFile)
  }
}

const main = () => {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof InputError)) throw error

    console.error(error.message)
    process.exitCode = 2
  }
}

// Compared after resolving links, so the check holds when the script is reached through a symlink.
const invokedPath = process.argv[1]

if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
