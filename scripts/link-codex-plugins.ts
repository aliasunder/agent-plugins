#!/usr/bin/env bun
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const pluginNames = ["ship-check", "plan-check"] as const;
const children = ["skills", "agents", ".claude-plugin", "README.md"] as const;
// Versions are single directory names with semver components and optional suffixes.
const versionPattern = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/;

type LinkOptions = {
  repoRoot: string;
  codexHome: string;
  check?: boolean;
};

type LinkResult = { current: boolean; changed: number; backupDirectory: string | undefined };

const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

const statIfPresent = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
};

const requireDirectory = async (path: string) => {
  const stat = await statIfPresent(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${path}`);
  }
};

const contains = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
};

/** Keep Codex's version directories real; only their shared-source children link out. */
export const linkPlugins = async (options: LinkOptions): Promise<LinkResult> => {
  const repoRoot = await realpath(resolve(options.repoRoot));
  const codexHome = await realpath(resolve(options.codexHome));
  if (dirname(repoRoot) === repoRoot || dirname(codexHome) === codexHome) {
    throw new Error("Refusing a filesystem root as the repository or Codex home.");
  }
  if (contains(repoRoot, codexHome) || contains(codexHome, repoRoot)) {
    throw new Error("Repository and Codex home must be separate directories.");
  }
  await requireDirectory(join(repoRoot, "plugins"));
  for (const path of ["plugins", "plugins/cache", "plugins/cache/agent-plugins"]) {
    const directory = join(codexHome, path);
    if (!(await statIfPresent(directory))) {
      throw new Error("Install first: codex plugin marketplace add <repo>, then codex plugin add ship-check@agent-plugins --json and codex plugin add plan-check@agent-plugins --json");
    }
    await requireDirectory(directory);
  }

  const backupRoot = join(codexHome, "plugin-link-backups");
  if (await statIfPresent(backupRoot)) await requireDirectory(backupRoot);
  const pending: { source: string; destination: string; backupPath: string; exists: boolean }[] = [];

  // Finish validation for both plugins before moving any installed content.
  for (const plugin of pluginNames) {
    const sourceRoot = join(repoRoot, "plugins", plugin);
    await requireDirectory(sourceRoot);
    for (const child of children) {
      const source = join(sourceRoot, child);
      const stat = await statIfPresent(source);
      if (!stat || stat.isSymbolicLink() || (child === "README.md" ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`Expected a real ${child === "README.md" ? "file" : "directory"}: ${source}`);
      }
    }
    const manifest: unknown = JSON.parse(await readFile(join(sourceRoot, ".claude-plugin/plugin.json"), "utf8"));
    if (
      !manifest || typeof manifest !== "object" ||
      !("name" in manifest) || manifest.name !== plugin ||
      !("version" in manifest) || typeof manifest.version !== "string" ||
      !versionPattern.test(manifest.version)
    ) {
      throw new Error(`Invalid plugin name or version: ${sourceRoot}/.claude-plugin/plugin.json`);
    }
    const cacheRoot = join(codexHome, "plugins/cache/agent-plugins", plugin);
    const versionRoot = join(cacheRoot, manifest.version);
    if (!(await statIfPresent(cacheRoot)) || !(await statIfPresent(versionRoot))) {
      throw new Error(`Install ${plugin} ${manifest.version} first: codex plugin add ${plugin}@agent-plugins --json`);
    }
    await requireDirectory(cacheRoot);
    await requireDirectory(versionRoot);
    for (const child of children) {
      const source = join(sourceRoot, child);
      const destination = join(versionRoot, child);
      const stat = await statIfPresent(destination);
      if (stat?.isSymbolicLink()) {
        try {
          if (await realpath(destination) === source) continue;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      pending.push({ source, destination, backupPath: join(plugin, manifest.version, child), exists: Boolean(stat) });
    }
  }

  if (options.check || !pending.length) {
    return { current: !pending.length, changed: 0, backupDirectory: undefined };
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupDirectory = await mkdtemp(join(backupRoot, "links-"));
  for (const entry of pending) {
    if (entry.exists) {
      const backup = join(backupDirectory, entry.backupPath);
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
      await rename(entry.destination, backup);
    }
    await symlink(entry.source, entry.destination);
  }
  return { current: true, changed: pending.length, backupDirectory };
};

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        check: { type: "boolean", default: false },
        "repo-root": { type: "string" },
        "codex-home": { type: "string" },
      },
    });
    const result = await linkPlugins({
      repoRoot: values["repo-root"] ?? resolve(import.meta.dir, ".."),
      codexHome: values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      check: values.check,
    });
    console.log(result.current ? `Codex plugin links current (${result.changed} changed).` : "Codex plugin links stale; run without --check to link them.");
    if (result.backupDirectory) console.log(`Original cache content: ${result.backupDirectory}`);
    process.exitCode = result.current ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
