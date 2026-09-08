import { afterEach, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syncCodex } from "../sync-codex";

const temporaryDirectories = new Set<string>();
const roles = [
  ["ship-check", "pr-reviewer", "pr-review"],
  ["ship-check", "code-quality-reviewer", "code-quality"],
  ["ship-check", "test-auditor", "test-audit"],
  ["ship-check", "bug-checker", "bug-check"],
  ["plan-check", "plan-reviewer", "plan-review"],
];

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

type NativeAgent = { name: string; description: string; developer_instructions: string; sandbox_mode?: string };
const isNativeAgent = (value: unknown): value is NativeAgent => Boolean(value) && typeof value === "object" && value !== null &&
  "name" in value && typeof value.name === "string" &&
  "description" in value && typeof value.description === "string" &&
  "developer_instructions" in value && typeof value.developer_instructions === "string" &&
  (!("sandbox_mode" in value) || typeof value.sandbox_mode === "string");
const parseAgent = (content: string) => {
  const value = Bun.TOML.parse(content);
  if (!isNativeAgent(value)) throw new Error("Expected a valid native agent TOML document.");
  return value;
};

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-agent-sync-test-")));
  temporaryDirectories.add(root);
  const options = { repoRoot: join(root, "repo"), codexHome: join(root, "codex"), skillRoot: join(root, "skills") };
  await mkdir(options.codexHome);
  await mkdir(join(options.skillRoot, "fable-mode"), { recursive: true });
  await writeFile(join(options.skillRoot, "fable-mode/SKILL.md"), "---\nname: fable-mode\ndescription: Common skill\n---\n\nShared skill body.\n");
  for (const [plugin, role, skill] of roles) {
    const base = join(options.repoRoot, "plugins", plugin);
    await mkdir(join(base, "agents"), { recursive: true });
    await mkdir(join(base, "skills", skill), { recursive: true });
    await writeFile(join(base, "agents", `${role}.md`), `---\nname: ${role}\ndescription: Review \\"quoted\\" code\nmodel: inherit\ncolor: blue\ntools: [Read, Bash, mcp__vault-cortex__vault_read_note]\nskills: [${skill}, fable-mode]\n---\n\nOriginal ${role} body. Quotes: "hello"; slash: \\\\.\n`);
    await writeFile(join(base, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Review skill\n---\n\nComplete ${skill} instructions.\n`);
  }
  return options;
};

test("generates five parsed native roles with full skill bodies and inherited configuration", async () => {
  const options = await fixture();
  const sourcePaths = [
    ...roles.flatMap(([plugin, role, skill]) => [join(options.repoRoot, "plugins", plugin, "agents", `${role}.md`), join(options.repoRoot, "plugins", plugin, "skills", skill, "SKILL.md")]),
    join(options.skillRoot, "fable-mode/SKILL.md"),
  ];
  const originalSources = await Promise.all(sourcePaths.map(path => readFile(path, "utf8")));
  expect(await syncCodex(options)).toEqual({ current: true, changed: 5, linksChanged: 0, backupDirectory: undefined });
  expect((await readdir(join(options.codexHome, "agents"))).toSorted()).toEqual(roles.map(([plugin, role]) => `${plugin}-${role}.toml`).toSorted());
  for (const [plugin, role, skill] of roles) {
    const content = await readFile(join(options.codexHome, "agents", `${plugin}-${role}.toml`), "utf8");
    const parsed = parseAgent(content);
    expect(parsed.name).toBe(`${plugin}:${role}`);
    expect(parsed.description).toBe('Review \\"quoted\\" code');
    expect(Object.keys(parsed).toSorted()).toEqual((plugin === "plan-check" ? ["name", "description", "developer_instructions", "sandbox_mode"] : ["name", "description", "developer_instructions"]).toSorted());
    expect(parsed.sandbox_mode).toBe(plugin === "plan-check" ? "read-only" : undefined);
    expect(parsed.developer_instructions).toContain(`\n\nOriginal ${role} body. Quotes: "hello"; slash: \\\\.\n`);
    expect(parsed.developer_instructions).toContain(`\n\nComplete ${skill} instructions.\n`);
    expect(parsed.developer_instructions).toContain("\n\nShared skill body.\n");
    expect(parsed.developer_instructions).toContain("Source-declared permitted operations: read files, execute shell commands, vault_read_note. Treat this list as an instruction-level constraint; do not use other operations just because inherited tools expose them.");
    expect(content).toContain(`# Source ${JSON.stringify(join(options.skillRoot, "fable-mode/SKILL.md"))} sha256=`);
  }
  expect(await Promise.all(sourcePaths.map(path => readFile(path, "utf8")))).toEqual(originalSources);
  expect(await readdir(options.codexHome)).toEqual(["agents"]);
});

test("check never creates files and unchanged reruns preserve output inodes without backups", async () => {
  const options = await fixture();
  expect(await syncCodex({ ...options, check: true })).toEqual({ current: false, changed: 0, linksChanged: 0 });
  expect(await readdir(options.codexHome)).toEqual([]);
  await syncCodex(options);
  const output = join(options.codexHome, "agents/ship-check-pr-reviewer.toml");
  const before = await lstat(output);
  expect(await syncCodex(options)).toEqual({ current: true, changed: 0, linksChanged: 0 });
  expect(await syncCodex({ ...options, check: true })).toEqual({ current: true, changed: 0, linksChanged: 0 });
  expect((await lstat(output)).ino).toBe(before.ino);
  expect(await readdir(options.codexHome)).toEqual(["agents"]);
});

test("source and shared skill changes produce deterministic updates while preserving originals", async () => {
  const options = await fixture();
  await syncCodex(options);
  const output = join(options.codexHome, "agents/ship-check-pr-reviewer.toml");
  const original = await readFile(output, "utf8");
  const source = join(options.repoRoot, "plugins/ship-check/agents/pr-reviewer.md");
  await writeFile(source, `${await readFile(source, "utf8")}Additional role instruction.\n`);
  const skill = join(options.skillRoot, "fable-mode/SKILL.md");
  await writeFile(skill, `${await readFile(skill, "utf8")}Additional shared instruction.\n`);
  expect((await syncCodex({ ...options, check: true })).current).toBe(false);
  expect(await readFile(output, "utf8")).toBe(original);
  const result = await syncCodex(options);
  expect(result.changed).toBe(5);
  if (!result.backupDirectory) throw new Error("Expected backups of replaced outputs.");
  expect(await readFile(join(result.backupDirectory, "ship-check-pr-reviewer.toml"), "utf8")).toBe(original);
  const updated = await readFile(output, "utf8");
  expect(parseAgent(updated).developer_instructions).toContain("Additional role instruction.\n");
  expect(parseAgent(updated).developer_instructions).toContain("Additional shared instruction.\n");
  expect((await syncCodex(options)).changed).toBe(0);
  expect(await readFile(output, "utf8")).toBe(updated);
  expect(await readdir(join(options.codexHome, "agent-sync-backups"))).toHaveLength(1);
});

test.each([
  ["model: inherit", "model: fixed-model", "Agent model must be inherit:"],
  ["color: blue", "color: blue\nunknown: value", "Unsupported agent fields"],
  ["tools: [Read, Bash, mcp__vault-cortex__vault_read_note]", "tools: [UnknownTool]", "Unsupported or missing agent tools:"],
  ["skills: [plan-review, fable-mode]", "skills: [missing-skill]", "Missing required source:"],
])("invalid source (%s) fails before any agent output is written", async (from, to, message) => {
  const options = await fixture();
  const source = join(options.repoRoot, "plugins/plan-check/agents/plan-reviewer.md");
  await writeFile(source, (await readFile(source, "utf8")).replace(from, to));
  await expect(syncCodex(options)).rejects.toThrow(message);
  expect(await readdir(options.codexHome)).toEqual([]);
});

test("refuses unrelated output files before creating other agents", async () => {
  const options = await fixture();
  await mkdir(join(options.codexHome, "agents"));
  const output = join(options.codexHome, "agents/plan-check-plan-reviewer.toml");
  await writeFile(output, 'name = "personal-role"\n');
  await expect(syncCodex(options)).rejects.toThrow(`Refusing to replace an unowned agent file: ${output}`);
  expect(await readFile(output, "utf8")).toBe('name = "personal-role"\n');
  expect(await readdir(join(options.codexHome, "agents"))).toEqual(["plan-check-plan-reviewer.toml"]);
});

test("a concurrent run rejects the existing lock without stealing it", async () => {
  const options = await fixture();
  const lock = join(options.codexHome, ".agent-plugins-sync.lock");
  const content = JSON.stringify({ pid: process.pid, token: "active-other-run" });
  await writeFile(lock, content);
  await expect(syncCodex(options)).rejects.toThrow(`Sync lock exists: ${lock}. Read its PID, verify that process has stopped, then remove the stale lock manually; active runs must finish first.`);
  expect(await readFile(lock, "utf8")).toBe(content);
  expect(await readdir(options.codexHome)).toEqual([".agent-plugins-sync.lock"]);
});

test("rerunning an interrupted owned output set restores missing roles without rewriting completed ones", async () => {
  const options = await fixture();
  await syncCodex(options);
  const output = join(options.codexHome, "agents/plan-check-plan-reviewer.toml");
  const expected = await readFile(output, "utf8");
  const untouched = join(options.codexHome, "agents/ship-check-pr-reviewer.toml");
  const before = await lstat(untouched);
  await rm(output);
  expect((await syncCodex(options)).changed).toBe(1);
  expect(await readFile(output, "utf8")).toBe(expected);
  expect((await lstat(untouched)).ino).toBe(before.ino);
  expect(await readdir(options.codexHome)).toEqual(["agents"]);
});

test("refuses symlinked output directories and detects obsolete owned roles", async () => {
  const options = await fixture();
  const agents = join(options.codexHome, "agents");
  await symlink(options.repoRoot, agents);
  await expect(syncCodex(options)).rejects.toThrow(`Expected a real directory: ${agents}`);
  await rm(agents);
  await syncCodex(options);
  const obsolete = join(agents, "old-role.toml");
  await cp(join(agents, "ship-check-pr-reviewer.toml"), obsolete);
  await expect(syncCodex({ ...options, check: true })).rejects.toThrow(`Obsolete generated agent: ${obsolete}. Move it outside the agents directory, then rerun sync.`);
});

test("optional cache linking validates both installations before writing agents", async () => {
  const options = await fixture();
  await expect(syncCodex({ ...options, linkPlugins: true })).rejects.toThrow("Install first:");
  expect(await readdir(options.codexHome)).toEqual([]);
});

test("CLI check returns a stale exit status without writing to an empty profile", async () => {
  const options = await fixture();
  const command = [process.execPath, resolve(import.meta.dir, "../sync-codex.ts"), "--check", "--repo-root", options.repoRoot, "--codex-home", options.codexHome, "--skill-root", options.skillRoot];
  const result = Bun.spawnSync(command);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("Codex sync stale; rerun without --check.\n");
  expect(await readdir(options.codexHome)).toEqual([]);
});
