import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkPlugins } from "../link-codex-plugins";

const temporaryDirectories = new Set<string>();
const plugins = ["ship-check", "plan-check"];
const version = "1.1.1";

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-plugin-links-test-")));
  temporaryDirectories.add(root);
  const repoRoot = join(root, "repo");
  const codexHome = join(root, "codex");
  for (const plugin of plugins) {
    for (const [base, label] of [[join(repoRoot, "plugins", plugin), "source"], [join(codexHome, "plugins/cache/agent-plugins", plugin, version), "installed"]]) {
      for (const directory of ["skills", "agents", ".claude-plugin"]) await mkdir(join(base, directory), { recursive: true });
      await writeFile(join(base, ".claude-plugin/plugin.json"), JSON.stringify({ name: plugin, version }));
      await writeFile(join(base, "skills/SKILL.md"), `${label} skill for ${plugin}`);
      await writeFile(join(base, "agents/reviewer.md"), `${label} reviewer for ${plugin}`);
      await writeFile(join(base, "README.md"), `${label} readme for ${plugin}`);
    }
  }
  return { repoRoot, codexHome };
};

test("links both plugins without changing source files, and saves installed originals outside the cache", async () => {
  const options = await fixture();
  const result = await linkPlugins(options);
  expect(result.current).toBe(true);
  expect(result.changed).toBe(8);
  if (!result.backupDirectory) throw new Error("Expected a backup directory after linking.");
  expect(result.backupDirectory?.startsWith(join(options.codexHome, "plugin-link-backups/"))).toBe(true);
  expect((await lstat(result.backupDirectory)).mode & 0o777).toBe(0o700);
  for (const plugin of plugins) {
    const source = join(options.repoRoot, "plugins", plugin);
    const cache = join(options.codexHome, "plugins/cache/agent-plugins", plugin, version);
    expect((await lstat(cache)).isSymbolicLink()).toBe(false);
    for (const child of ["skills", "agents", ".claude-plugin", "README.md"]) {
      expect((await lstat(join(cache, child))).isSymbolicLink()).toBe(true);
      expect(await realpath(join(cache, child))).toBe(join(source, child));
    }
    for (const [file, label] of [["skills/SKILL.md", "skill"], ["agents/reviewer.md", "reviewer"], ["README.md", "readme"]]) {
      expect(await readFile(join(source, file), "utf8")).toBe(`source ${label} for ${plugin}`);
      expect(await readFile(join(result.backupDirectory, plugin, version, file), "utf8")).toBe(`installed ${label} for ${plugin}`);
    }
    expect(JSON.parse(await readFile(join(source, ".claude-plugin/plugin.json"), "utf8"))).toEqual({ name: plugin, version });
    expect(JSON.parse(await readFile(join(result.backupDirectory, plugin, version, ".claude-plugin/plugin.json"), "utf8"))).toEqual({ name: plugin, version });
  }
});

test("check is read-only and a second run preserves existing links and backups", async () => {
  const options = await fixture();
  expect(await linkPlugins({ ...options, check: true })).toEqual({ current: false, changed: 0, backupDirectory: undefined });
  expect(await readdir(options.codexHome)).toEqual(["plugins"]);
  const readme = join(options.codexHome, "plugins/cache/agent-plugins/ship-check", version, "README.md");
  expect(await readFile(readme, "utf8")).toBe("installed readme for ship-check");
  await linkPlugins(options);
  const before = await lstat(readme);
  const backups = await readdir(join(options.codexHome, "plugin-link-backups"));
  expect(await linkPlugins(options)).toEqual({ current: true, changed: 0, backupDirectory: undefined });
  expect(await linkPlugins({ ...options, check: true })).toEqual({ current: true, changed: 0, backupDirectory: undefined });
  expect((await lstat(readme)).ino).toBe(before.ino);
  expect(await readdir(join(options.codexHome, "plugin-link-backups"))).toEqual(backups);
});

test("missing second plugin installation fails preflight before touching the first", async () => {
  const options = await fixture();
  await rm(join(options.codexHome, "plugins/cache/agent-plugins/plan-check"), { recursive: true });
  await expect(linkPlugins(options)).rejects.toThrow("codex plugin add plan-check@agent-plugins --json");
  expect(await readdir(options.codexHome)).toEqual(["plugins"]);
  const first = join(options.codexHome, "plugins/cache/agent-plugins/ship-check", version, "README.md");
  expect((await lstat(first)).isSymbolicLink()).toBe(false);
  expect(await readFile(first, "utf8")).toBe("installed readme for ship-check");
});

test("a source version change requires the matching installed version", async () => {
  const options = await fixture();
  await writeFile(join(options.repoRoot, "plugins/plan-check/.claude-plugin/plugin.json"), JSON.stringify({ name: "plan-check", version: "1.2.0" }));
  await expect(linkPlugins(options)).rejects.toThrow("Install plan-check 1.2.0 first: codex plugin add plan-check@agent-plugins --json");
  expect(await readdir(options.codexHome)).toEqual(["plugins"]);
  expect(await readFile(join(options.codexHome, "plugins/cache/agent-plugins/ship-check", version, "README.md"), "utf8")).toBe("installed readme for ship-check");
});

test("missing source content fails before any installed files move", async () => {
  const options = await fixture();
  const missing = join(options.repoRoot, "plugins/plan-check/README.md");
  await rm(missing);
  await expect(linkPlugins(options)).rejects.toThrow(`Expected a real file: ${missing}`);
  expect(await readdir(options.codexHome)).toEqual(["plugins"]);
  expect(await readFile(join(options.codexHome, "plugins/cache/agent-plugins/ship-check", version, "README.md"), "utf8")).toBe("installed readme for ship-check");
});

test("refuses symlinked version directories and backup directories", async () => {
  const options = await fixture();
  const cache = join(options.codexHome, "plugins/cache/agent-plugins/plan-check", version);
  await rm(cache, { recursive: true });
  await symlink(join(options.repoRoot, "plugins/plan-check"), cache);
  await expect(linkPlugins(options)).rejects.toThrow(`Expected a real directory: ${cache}`);
  expect(await readdir(options.codexHome)).toEqual(["plugins"]);
  await rm(cache);
  await mkdir(cache);
  await symlink(options.repoRoot, join(options.codexHome, "plugin-link-backups"));
  await expect(linkPlugins(options)).rejects.toThrow("Expected a real directory:");
});
