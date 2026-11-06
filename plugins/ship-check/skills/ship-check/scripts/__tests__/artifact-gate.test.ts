import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { type ExemptClass, type GateInput, type GateResult, GitError, classify } from "../artifact-gate.ts"

const SCRIPT_PATH = fileURLToPath(new URL("../artifact-gate.ts", import.meta.url))

const ARTIFACT_PATHSPECS = [
  "src/",
  "rootfs/",
  "Dockerfile*",
  ".nvmrc",
  "package.json",
  "package-lock.json",
  ".github/workflows/test_deploy.yml",
  ":(exclude,glob)**/__tests__/**",
  ":(exclude,glob)**/*.test.*",
]
const AUDIT_PATHSPECS = ["cli/"]

const IMAGE_SCRIPTS = ["build:server", "build"]
const LIVE_TEST_PACKAGES = ["obsidian-headless", "rrule"]

// The suffix the gate adds to a reason when the orchestrator may still judge the hunk comment-only.
const JUDGE = "judge the hunk, deploy when unsure"

const PACKAGE_JSON = {
  name: "fixture",
  scripts: { "build:server": "tsc", lint: "eslint .", prepare: "husky" },
  dependencies: { hono: "4.6.0", rrule: "2.8.1" },
  devDependencies: { vitest: "2.1.0" },
  // A nested override, as npm allows, so an unchanged object beside a bump must compare by value.
  overrides: { "@scope/transformers": { sharp: "0.35.5" } },
}

const LOCK_PACKAGES = {
  "": { dependencies: { hono: "4.6.0" } },
  "node_modules/hono": { version: "4.6.0" },
  "node_modules/obsidian-headless": { version: "1.0.0" },
}

// Printed the way npm writes the file, so a version bump leaves each entry's key line unchanged.
const lockfileWith = (packages: Readonly<Record<string, unknown>>): string => {
  return `${JSON.stringify({ lockfileVersion: 3, packages }, null, 2)}\n`
}

const DOCKERFILE = [
  "# syntax=docker/dockerfile:1",
  "FROM node:24-trixie-slim@sha256:aaa AS base",
  "FROM base AS deps",
  "RUN npm ci",
  "FROM base AS remote",
].join("\n")

const WORKFLOW = ["jobs:", "  deploy:", "    steps:", "      - uses: actions/checkout@v4.2.2", "      - run: echo hi"].join("\n")

const SOURCE = ["const PATTERN = /`+[^`\\n]*`+/g // odd backticks inside a regex", "export const run = (s: string): number => s.length // count"].join("\n")

const SHELL_SCRIPT = "#!/command/with-contenv sh\n# start\nexec node dist/src/server.js\n"

const temporaryRoots: string[] = []
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

type Files = Readonly<Record<string, string>>

const BASE_FILES: Files = {
  "package.json": JSON.stringify(PACKAGE_JSON, null, 2),
  "package-lock.json": lockfileWith(LOCK_PACKAGES),
  Dockerfile: DOCKERFILE,
  ".nvmrc": "24\n",
  ".github/workflows/test_deploy.yml": WORKFLOW,
  "src/server.ts": SOURCE,
  "src/__tests__/server.test.ts": "export {}\n",
  "rootfs/etc/run": SHELL_SCRIPT,
  "cli/src/docker.ts": "export const image = 'x'\n",
}

const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()

const writeFiles = (repo: string, files: Files): void => {
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

/**
 * A fixture repo with `BASE_FILES` (plus `baseChanges`) committed, then `changes` and `deletions` committed on
 * top; returns both commits.
 */
const fixture = (changes: Files, deletions: readonly string[] = [], baseChanges: Files = {}): { repo: string; base: string; head: string } => {
  const repo = mkdtempSync(join(tmpdir(), "probe-artifact-gate-"))
  temporaryRoots.push(repo)
  gitIn(repo, "init", "-q", "-b", "main")
  writeFiles(repo, { ...BASE_FILES, ...baseChanges })
  const base = commitAll(repo, "base")
  writeFiles(repo, changes)
  for (const path of deletions) rmSync(join(repo, path))
  const head = commitAll(repo, "change")
  return { repo, base, head }
}

const input = (repo: string, from: string, to: string, overrides: Partial<GateInput> = {}): GateInput => ({
  repo,
  from,
  to,
  range: "pr",
  pathspecs: ARTIFACT_PATHSPECS,
  auditPathspecs: AUDIT_PATHSPECS,
  exempt: ["dependency", "digest", "action", "comment", "scripts"],
  imageScripts: IMAGE_SCRIPTS,
  liveTestPackages: LIVE_TEST_PACKAGES,
  ...overrides,
})

const packageWith = (patch: (manifest: typeof PACKAGE_JSON) => void): string => {
  const manifest = structuredClone(PACKAGE_JSON)
  patch(manifest)
  return JSON.stringify(manifest, null, 2)
}

/** The result for one changed artifact file that fits no selected exemption. */
const artifactChange = (path: string, reason: string): GateResult => ({
  outcome: "artifact change",
  summary: `artifact change (1 files: ${path})`,
  files: [{ path, exemptAs: undefined, reason }],
})

/** The result for one changed artifact file exempt as the class. */
const exemptChange = (path: string, exemptClass: ExemptClass): GateResult => ({
  outcome: "exempt",
  summary: `exempt (${exemptClass})`,
  files: [{ path, exemptAs: exemptClass, reason: exemptClass }],
})

const NO_ARTIFACT_CHANGE: GateResult = { outcome: "no artifact change", summary: "no artifact change", files: [] }

/** Matches a GitError raised by the named git command, whatever git's own stderr says after it. */
const gitErrorFrom = (command: string) => (error: unknown): boolean => {
  return error instanceof GitError && error.message.startsWith(`${command} failed: `)
}

const runCli = (args: readonly string[]) => spawnSync("bun", [SCRIPT_PATH, ...args], { encoding: "utf8" })

describe("dependency class", () => {
  it("exempts a version bump of an existing package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1" }) })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("package.json", "dependency"))
  })

  it("keeps a bump of a live-test package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.rrule = "2.9.0" }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "rrule is a live-test package"))
  })

  it("keeps an added package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { Object.assign(manifest.dependencies, { zod: "3.0.0" }) }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "dependencies adds or removes a package"))
  })

  it("keeps a version string that swaps the package through an npm alias", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "npm:other@4.6.0" }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "dependencies.hono changes the package it installs"))
  })

  it("exempts an added override", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { Object.assign(manifest.overrides, { minimatch: "11.0.4" }) }) })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("package.json", "dependency"))
  })

  it("keeps an added override for a live-test package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { Object.assign(manifest.overrides, { rrule: "2.9.0" }) }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "rrule is a live-test package"))
  })

  it("keeps a change inside a nested override", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.overrides["@scope/transformers"].sharp = "0.35.6" }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "overrides.@scope/transformers is not a version string"))
  })

  const OFF_REGISTRY_SPECS = [
    { label: "a GitHub spec", spec: "github:honojs/hono#v4.6.1" },
    { label: "a file: spec", spec: "file:../hono" },
    { label: "a tarball URL", spec: "https://registry.example.com/hono-4.6.1.tgz" },
    { label: "an npm alias with no range", spec: "npm:hono" },
  ]
  for (const { label, spec } of OFF_REGISTRY_SPECS) {
    it(`keeps a move to ${label}, which leaves the registry`, () => {
      const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = spec }) })
      assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "dependencies.hono is not a registry version"))
    })
  }

  it("keeps a move from a file: spec back to a registry range", () => {
    const { repo, base, head } = fixture(
      { "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1" }) },
      [],
      { "package.json": packageWith((manifest) => { manifest.dependencies.hono = "file:../hono" }) },
    )
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "dependencies.hono is not a registry version"))
  })

  it("exempts a move to a dist-tag", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "latest" }) })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("package.json", "dependency"))
  })

  it("reads a live-test package through its npm alias", () => {
    const aliased = (range: string): string => packageWith((manifest) => { manifest.dependencies.hono = `npm:rrule@${range}` })
    const { repo, base, head } = fixture({ "package.json": aliased("2.9.0") }, [], { "package.json": aliased("2.8.1") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "rrule is a live-test package"))
  })

  it("keeps a bump that also edits scripts", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1"; manifest.scripts.lint = "biome" }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "scripts and dependencies changed together"))
  })

  it("keeps a change outside the scripts and dependency maps", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { Object.assign(manifest, { type: "module" }) }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "changes outside scripts and dependency maps"))
  })

  it("keeps a package.json that no longer parses", () => {
    const { repo, base, head } = fixture({ "package.json": "{ not json" })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "package.json unreadable at one side"))
  })

  it("exempts a lockfile-only change", () => {
    const { repo, base, head } = fixture({ "package-lock.json": lockfileWith({ ...LOCK_PACKAGES, "node_modules/hono": { version: "4.6.1" } }) })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("package-lock.json", "dependency"))
  })

  it("keeps a lockfile change to a live-test package", () => {
    const { repo, base, head } = fixture({ "package-lock.json": lockfileWith({ ...LOCK_PACKAGES, "node_modules/obsidian-headless": { version: "1.1.0" } }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package-lock.json", "obsidian-headless is a live-test package"))
  })

  it("keeps a lockfile change to a live-test package nested under its parent", () => {
    const nested = (version: string): string => lockfileWith({ ...LOCK_PACKAGES, "node_modules/hono/node_modules/rrule": { version } })
    const { repo, base, head } = fixture({ "package-lock.json": nested("2.9.0") }, [], { "package-lock.json": nested("2.8.1") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package-lock.json", "rrule is a live-test package"))
  })

  it("keeps a lockfile entry whose name field is a live-test package under another path", () => {
    // Only the aliased entry changes, so its name field is the one way to see the live-test package.
    const aliased = (version: string): string => lockfileWith({ ...LOCK_PACKAGES, "node_modules/headless": { name: "obsidian-headless", version } })
    const { repo, base, head } = fixture({ "package-lock.json": aliased("1.1.0") }, [], { "package-lock.json": aliased("1.0.0") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package-lock.json", "obsidian-headless is a live-test package"))
  })

  it("keeps a deleted lockfile", () => {
    const { repo, base, head } = fixture({}, ["package-lock.json"])
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package-lock.json", "package-lock.json has no packages map at one side"))
  })
})

describe("scripts class", () => {
  it("exempts a script the image never runs", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.scripts.lint = "biome check ." }) })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("package.json", "scripts"))
  })

  it("keeps an edit to a lifecycle hook", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.scripts.prepare = "husky && echo x" }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "scripts.prepare runs during the image build"))
  })

  // npm ci runs every one of these; prepare has its own test above.
  const ADDED_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "postprepare", "dependencies"]
  for (const scriptName of ADDED_LIFECYCLE_SCRIPTS) {
    it(`keeps an added ${scriptName} script, which npm ci runs`, () => {
      const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { Object.assign(manifest.scripts, { [scriptName]: "node patch.js" }) }) })
      assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", `scripts.${scriptName} runs during the image build`))
    })
  }

  it("keeps a post variant of an image script", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { Object.assign(manifest.scripts, { "postbuild:server": "node patch.js" }) }) })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "scripts.postbuild:server runs during the image build"))
  })

  it("keeps a script an image script reaches through npm run", () => {
    const chained = (compile: string): string => packageWith((manifest) => { Object.assign(manifest.scripts, { "build:server": "npm run compile && npm run-script bundle", compile, bundle: "esbuild" }) })
    const { repo, base, head } = fixture({ "package.json": chained("tsc --strict") }, [], { "package.json": chained("tsc") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "scripts.compile runs during the image build"))
  })

  it("follows npm run past its flags to the script name", () => {
    const chained = (compile: string): string => packageWith((manifest) => { Object.assign(manifest.scripts, { "build:server": "npm run --silent compile", compile }) })
    const { repo, base, head } = fixture({ "package.json": chained("tsc --strict") }, [], { "package.json": chained("tsc") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("package.json", "scripts.compile runs during the image build"))
  })
})

describe("digest and action classes", () => {
  it("exempts a digest-only FROM change", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb") })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("Dockerfile", "digest"))
  })

  it("keeps an image swap beside a digest bump", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("node:24-trixie-slim@sha256:aaa", "node:25-trixie-slim@sha256:bbb") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("Dockerfile", "a FROM line changes more than its digest"))
  })

  it("keeps a FROM line change with no digest", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("FROM base AS deps", "FROM base AS dependencies") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("Dockerfile", "a FROM line has no digest"))
  })

  it("sends a Dockerfile comment edit to the hunk judgement", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("# syntax=docker/dockerfile:1", "# syntax=docker/dockerfile:1 (pinned)") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("Dockerfile", `a changed line is not a FROM line; ${JUDGE}`))
  })

  it("sends an added workflow comment line to the hunk judgement", () => {
    const { repo, base, head } = fixture({ ".github/workflows/test_deploy.yml": `# deploys the test image\n${WORKFLOW}` })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange(".github/workflows/test_deploy.yml", `lines added or removed, not paired; ${JUDGE}`))
  })

  it("keeps a Dockerfile instruction change beside a digest bump", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb").replace("RUN npm ci", "RUN npm ci --omit=dev") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("Dockerfile", `a changed line is not a FROM line; ${JUDGE}`))
  })

  it("reads a changed line that starts with a dash beside a digest bump", () => {
    // In a `-U0` diff the continuation line reads `---no-install…`, the shape of a file header.
    const dockerfile = (digest: string, packages: string): string => [`FROM node:24-trixie-slim@sha256:${digest} AS base`, "RUN apt-get install \\", `--no-install-recommends ${packages}`].join("\n")
    const { repo, base, head } = fixture({ Dockerfile: dockerfile("bbb", "curl wget") }, [], { Dockerfile: dockerfile("aaa", "curl") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("Dockerfile", `a changed line is not a FROM line; ${JUDGE}`))
  })

  it("exempts an action version bump", () => {
    const { repo, base, head } = fixture({ ".github/workflows/test_deploy.yml": WORKFLOW.replace("@v4.2.2", "@v4.3.0") })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange(".github/workflows/test_deploy.yml", "action"))
  })

  it("keeps an action swap", () => {
    const { repo, base, head } = fixture({ ".github/workflows/test_deploy.yml": WORKFLOW.replace("actions/checkout@v4.2.2", "other/checkout@v4.2.2") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange(".github/workflows/test_deploy.yml", "the action changes from actions/checkout to other/checkout"))
  })

  it("keeps a uses: line edit that leaves the version alone", () => {
    const { repo, base, head } = fixture({ ".github/workflows/test_deploy.yml": WORKFLOW.replace("actions/checkout@v4.2.2", "actions/checkout@v4.2.2 # pinned") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange(".github/workflows/test_deploy.yml", "a uses: line changes outside its version"))
  })
})

describe("comment class", () => {
  it("exempts a TypeScript comment-only edit, regex with backticks included", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("// count", "// returns the length") })
    assert.deepEqual(classify(input(repo, base, head)), exemptChange("src/server.ts", "comment"))
  })

  it("keeps a code change", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("s.length", "s.length + 1") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("src/server.ts", "code changed beyond comments"))
  })

  it("keeps an added code file", () => {
    const { repo, base, head } = fixture({ "src/extra.ts": "export const extra = 1\n" })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("src/extra.ts", "file unreadable at one side"))
  })

  it("keeps a deleted code file", () => {
    const { repo, base, head } = fixture({}, ["src/server.ts"])
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("src/server.ts", "file unreadable at one side"))
  })

  it("keeps a code file the transpiler cannot parse", () => {
    const { repo, base, head } = fixture({ "src/server.ts": "export const = ;\n" })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("src/server.ts", "the transpiler could not parse the file"))
  })

  it("keeps a shell comment edit for judgement", () => {
    const { repo, base, head } = fixture({ "rootfs/etc/run": SHELL_SCRIPT.replace("# start", "# start the server") })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("rootfs/etc/run", `no deterministic class for this file type; ${JUDGE}`))
  })
})

describe("paths and ranges", () => {
  it("ignores test files and reports no artifact change", () => {
    const { repo, base, head } = fixture({ "src/__tests__/server.test.ts": "export const x = 1\n" })
    assert.deepEqual(classify(input(repo, base, head)), NO_ARTIFACT_CHANGE)
  })

  it("reports a change under an audit path only as local change", () => {
    const { repo, base, head } = fixture({ "cli/src/docker.ts": "export const image = 'y'\n" })
    assert.deepEqual(classify(input(repo, base, head)), {
      outcome: "local change",
      summary: "local change (1 files)",
      files: [{ path: "cli/src/docker.ts", exemptAs: undefined, reason: "audit path" }],
    })
  })

  it("lists only artifact files when artifact and audit paths both change", () => {
    const { repo, base, head } = fixture({ ".nvmrc": "25\n", Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb"), "cli/src/docker.ts": "export const image = 'y'\n" })
    assert.deepEqual(classify(input(repo, base, head)), {
      outcome: "artifact change",
      summary: "artifact change (1 files: .nvmrc)",
      files: [
        { path: ".nvmrc", exemptAs: undefined, reason: `no deterministic class for this file type; ${JUDGE}` },
        { path: "Dockerfile", exemptAs: "digest", reason: "digest" },
      ],
    })
  })

  it("names each exemption class once, in order, when several files are exempt", () => {
    const { repo, base, head } = fixture({
      Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb"),
      "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1" }),
      "package-lock.json": lockfileWith({ ...LOCK_PACKAGES, "node_modules/hono": { version: "4.6.1" } }),
    })
    assert.deepEqual(classify(input(repo, base, head)), {
      outcome: "exempt",
      summary: "exempt (dependency, digest)",
      files: [
        { path: "Dockerfile", exemptAs: "digest", reason: "digest" },
        { path: "package-lock.json", exemptAs: "dependency", reason: "dependency" },
        { path: "package.json", exemptAs: "dependency", reason: "dependency" },
      ],
    })
  })

  it("lists no file for an empty artifact path list, rather than every changed file", () => {
    const { repo, base, head } = fixture({ ".nvmrc": "25\n" })
    assert.deepEqual(classify(input(repo, base, head, { pathspecs: [] })), NO_ARTIFACT_CHANGE)
  })

  it("keeps a deleted artifact file", () => {
    const { repo, base, head } = fixture({}, ["rootfs/etc/run"])
    assert.deepEqual(classify(input(repo, base, head)), artifactChange("rootfs/etc/run", `no deterministic class for this file type; ${JUDGE}`))
  })

  it("keeps a file with no class, such as .nvmrc", () => {
    const { repo, base, head } = fixture({ ".nvmrc": "25\n" })
    assert.deepEqual(classify(input(repo, base, head)), artifactChange(".nvmrc", `no deterministic class for this file type; ${JUDGE}`))
  })

  it("keeps a class the profile did not select", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb") })
    assert.deepEqual(classify(input(repo, base, head, { exempt: ["dependency"] })), artifactChange("Dockerfile", "digest is not a selected exemption"))
  })

  it("reads old content from the merge base in pr range after the base branch moves on", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1" }) })
    gitIn(repo, "checkout", "-q", "-b", "moved", base)
    writeFiles(repo, { "package.json": packageWith((manifest) => { manifest.scripts.lint = "biome check ." }) })
    const moved = commitAll(repo, "base branch moves on")
    // Old content read from `moved` would make the PR seem to revert the lint edit, so scripts and dependencies would both change.
    assert.deepEqual(classify(input(repo, moved, head)), exemptChange("package.json", "dependency"))
  })

  it("compares trees in tested range, so a reset head is a change the pr range misses", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("s.length", "s.length + 1") })
    // Compare the tested head with its own parent: the pr range sees nothing because the parent is an ancestor.
    assert.deepEqual(classify(input(repo, head, base)), NO_ARTIFACT_CHANGE)
    assert.deepEqual(classify(input(repo, head, base, { range: "tested" })), artifactChange("src/server.ts", "code changed beyond comments"))
  })

  it("throws a GitError on a commit git does not know", () => {
    const { repo, base } = fixture({ ".nvmrc": "25\n" })
    const unknown = "0".repeat(40)
    const command = `git diff --name-only ${base}...${unknown} -- ${ARTIFACT_PATHSPECS.join(" ")}`
    assert.throws(() => classify(input(repo, base, unknown)), gitErrorFrom(command))
  })

  it("throws a GitError when a file read fails for a reason other than absence", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("s.length", "s.length + 1") })
    // Remove the head's blob so `git show` fails on the object, not on the path.
    const blob = gitIn(repo, "rev-parse", `${head}:src/server.ts`)
    rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
    assert.throws(() => classify(input(repo, base, head)), gitErrorFrom(`git show ${head}:src/server.ts`))
  })
})

describe("command line", () => {
  const bumpArgs = (repo: string, base: string, head: string): string[] => {
    return ["--repo", repo, "--from", base, "--to", head, "--exempt", "dependency,digest", "--live-test-package", "rrule", ...ARTIFACT_PATHSPECS.flatMap((spec) => ["--pathspec", spec])]
  }

  it("prints the summary", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1" }) })
    const { status, stdout, stderr } = runCli(bumpArgs(repo, base, head))
    assert.deepEqual({ status, stdout, stderr }, { status: 0, stdout: "exempt (dependency)\n", stderr: "" })
  })

  it("prints the whole result with --json", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((manifest) => { manifest.dependencies.hono = "4.6.1" }) })
    const { status, stdout, stderr } = runCli([...bumpArgs(repo, base, head), "--json"])
    const expected = { outcome: "exempt", summary: "exempt (dependency)", files: [{ path: "package.json", exemptAs: "dependency", reason: "dependency" }] }
    assert.deepEqual({ status, stdout, stderr }, { status: 0, stdout: `${JSON.stringify(expected, null, 2)}\n`, stderr: "" })
  })

  it("exits 2 on a git failure", () => {
    const { repo, base } = fixture({ ".nvmrc": "25\n" })
    const { status, stdout, stderr } = runCli(["--repo", repo, "--from", base, "--to", "nope", "--pathspec", "src/"])
    // git's own message follows the prefix and varies by git version.
    const prefix = `git diff --name-only ${base}...nope -- src/ failed: `
    assert.deepEqual({ status, stdout, stderrPrefix: stderr.slice(0, prefix.length) }, { status: 2, stdout: "", stderrPrefix: prefix })
  })

  const REFUSALS = [
    { label: "a run with no pathspec at all", args: (repo: string, base: string, head: string) => ["--repo", repo, "--from", base, "--to", head], message: "at least one --pathspec or --audit-pathspec is required" },
    { label: "a --from that git would read as an option", args: (repo: string, _base: string, head: string) => ["--repo", repo, "--from=--output=/dev/null", "--to", head, "--pathspec", "src/"], message: "--from and --to must name commits, not options" },
    { label: "a --to that git would read as an option", args: (repo: string, base: string) => ["--repo", repo, "--from", base, "--to=--output=/dev/null", "--pathspec", "src/"], message: "--from and --to must name commits, not options" },
    { label: "a run with no --repo", args: (_repo: string, base: string, head: string) => ["--from", base, "--to", head, "--pathspec", "src/"], message: "--repo, --from and --to are required" },
    { label: "a range other than pr or tested", args: (repo: string, base: string, head: string) => ["--repo", repo, "--from", base, "--to", head, "--range", "both", "--pathspec", "src/"], message: "--range must be pr or tested" },
    { label: "an unknown exemption class", args: (repo: string, base: string, head: string) => ["--repo", repo, "--from", base, "--to", head, "--exempt", "dependency,docs", "--pathspec", "src/"], message: "unknown exemption class: docs" },
  ]
  for (const { label, args, message } of REFUSALS) {
    it(`refuses ${label}`, () => {
      const { repo, base, head } = fixture({ ".nvmrc": "25\n" })
      const { status, stdout, stderr } = runCli(args(repo, base, head))
      assert.deepEqual({ status, stdout, stderr }, { status: 1, stdout: "", stderr: `${message}\n` })
    })
  }
})
