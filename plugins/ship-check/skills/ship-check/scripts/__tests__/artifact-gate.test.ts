import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { type GateInput, type GateResult, GitError, classify } from "../artifact-gate.ts"

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

const IMAGE_SCRIPTS = ["build:server", "build"]
const LIVE_TEST_PACKAGES = ["obsidian-headless", "rrule"]

const PACKAGE_JSON = {
  name: "fixture",
  scripts: { "build:server": "tsc", lint: "eslint .", prepare: "husky" },
  dependencies: { hono: "4.6.0", rrule: "2.8.1" },
  devDependencies: { vitest: "2.1.0" },
}

const LOCKFILE = [
  "{",
  '  "packages": {',
  '    "node_modules/hono": { "version": "4.6.0" },',
  '    "node_modules/obsidian-headless": { "version": "1.0.0" }',
  "  }",
  "}",
  "",
].join("\n")

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
  "package-lock.json": LOCKFILE,
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

/** A fixture repo with `BASE_FILES` committed, then `changes` committed on top; returns both commits. */
const fixture = (changes: Files): { repo: string; base: string; head: string } => {
  const repo = mkdtempSync(join(tmpdir(), "probe-artifact-gate-"))
  temporaryRoots.push(repo)
  gitIn(repo, "init", "-q", "-b", "main")
  writeFiles(repo, BASE_FILES)
  const base = commitAll(repo, "base")
  writeFiles(repo, changes)
  const head = commitAll(repo, "change")
  return { repo, base, head }
}

const input = (repo: string, from: string, to: string, overrides: Partial<GateInput> = {}): GateInput => ({
  repo,
  from,
  to,
  range: "pr",
  pathspecs: ARTIFACT_PATHSPECS,
  auditPathspecs: [...ARTIFACT_PATHSPECS, "cli/"],
  exempt: ["dependency", "digest", "action", "comment", "scripts"],
  imageScripts: IMAGE_SCRIPTS,
  liveTestPackages: LIVE_TEST_PACKAGES,
  ...overrides,
})

const packageWith = (patch: (copy: typeof PACKAGE_JSON) => void): string => {
  const copy = structuredClone(PACKAGE_JSON)
  patch(copy)
  return JSON.stringify(copy, null, 2)
}

/** The first file verdict's reason; a result with no files is a test bug, not a passing case. */
const firstReason = (result: GateResult): string => {
  const first = result.files[0]
  if (!first) throw new Error(`expected a file verdict, got ${result.word}`)
  return first.reason
}

describe("dependency class", () => {
  it("exempts a version bump of an existing package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((p) => { p.dependencies.hono = "4.6.1" }) })
    assert.equal(classify(input(repo, base, head)).word, "exempt (dependency)")
  })

  it("keeps a bump of a live-test package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((p) => { p.dependencies.rrule = "2.9.0" }) })
    const result = classify(input(repo, base, head))
    assert.equal(result.outcome, "artifact change")
    assert.match(firstReason(result), /rrule is a live-test package/)
  })

  it("keeps an added package", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((p) => { Object.assign(p.dependencies, { zod: "3.0.0" }) }) })
    assert.equal(classify(input(repo, base, head)).outcome, "artifact change")
  })

  it("exempts an added override and keeps one for a live-test package", () => {
    const pinned = fixture({ "package.json": packageWith((p) => { Object.assign(p, { overrides: { minimatch: "11.0.4" } }) }) })
    assert.equal(classify(input(pinned.repo, pinned.base, pinned.head)).word, "exempt (dependency)")
    const live = fixture({ "package.json": packageWith((p) => { Object.assign(p, { overrides: { rrule: "2.9.0" } }) }) })
    const result = classify(input(live.repo, live.base, live.head))
    assert.equal(result.outcome, "artifact change")
    assert.match(firstReason(result), /rrule is a live-test package/)
  })

  it("keeps a bump that also edits scripts", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((p) => { p.dependencies.hono = "4.6.1"; p.scripts.lint = "biome" }) })
    assert.equal(classify(input(repo, base, head)).outcome, "artifact change")
  })

  it("exempts a lockfile-only change and keeps one that touches a live-test package", () => {
    const only = fixture({ "package-lock.json": LOCKFILE.replace("4.6.0", "4.6.1") })
    assert.equal(classify(input(only.repo, only.base, only.head)).word, "exempt (dependency)")
    const live = fixture({ "package-lock.json": LOCKFILE.replace('"version": "1.0.0"', '"version": "1.1.0"') })
    assert.equal(classify(input(live.repo, live.base, live.head)).outcome, "artifact change")
  })
})

describe("scripts class", () => {
  it("exempts a script the image never runs", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((p) => { p.scripts.lint = "biome check ." }) })
    assert.equal(classify(input(repo, base, head)).word, "exempt (scripts)")
  })

  it("keeps a lifecycle hook and a pre/post variant of an image script", () => {
    const prepare = fixture({ "package.json": packageWith((p) => { p.scripts.prepare = "husky && echo x" }) })
    assert.match(firstReason(classify(input(prepare.repo, prepare.base, prepare.head))), /scripts\.prepare runs during the image build/)
    const post = fixture({ "package.json": packageWith((p) => { Object.assign(p.scripts, { "postbuild:server": "node patch.js" }) }) })
    assert.equal(classify(input(post.repo, post.base, post.head)).outcome, "artifact change")
  })
})

describe("digest and action classes", () => {
  it("exempts a digest-only FROM change and keeps an image swap", () => {
    const digest = fixture({ Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb") })
    assert.equal(classify(input(digest.repo, digest.base, digest.head)).word, "exempt (digest)")
    const swap = fixture({ Dockerfile: DOCKERFILE.replace("node:24-trixie-slim@sha256:aaa", "node:25-trixie-slim@sha256:bbb") })
    assert.equal(classify(input(swap.repo, swap.base, swap.head)).outcome, "artifact change")
  })

  it("keeps a Dockerfile instruction change beside a digest bump", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb").replace("RUN npm ci", "RUN npm ci --omit=dev") })
    assert.equal(classify(input(repo, base, head)).outcome, "artifact change")
  })

  it("exempts an action version bump and keeps an action swap", () => {
    const bump = fixture({ ".github/workflows/test_deploy.yml": WORKFLOW.replace("@v4.2.2", "@v4.3.0") })
    assert.equal(classify(input(bump.repo, bump.base, bump.head)).word, "exempt (action)")
    const swap = fixture({ ".github/workflows/test_deploy.yml": WORKFLOW.replace("actions/checkout@v4.2.2", "other/checkout@v4.2.2") })
    assert.equal(classify(input(swap.repo, swap.base, swap.head)).outcome, "artifact change")
  })
})

describe("comment class", () => {
  it("exempts a TypeScript comment-only edit, regex with backticks included", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("// count", "// returns the length") })
    assert.equal(classify(input(repo, base, head)).word, "exempt (comment)")
  })

  it("keeps a code change", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("s.length", "s.length + 1") })
    assert.equal(classify(input(repo, base, head)).outcome, "artifact change")
  })

  it("keeps a shell comment edit for judgement", () => {
    const { repo, base, head } = fixture({ "rootfs/etc/run": SHELL_SCRIPT.replace("# start", "# start the server") })
    const result = classify(input(repo, base, head))
    assert.equal(result.outcome, "artifact change")
    assert.match(firstReason(result), /judge the hunk/)
  })
})

describe("paths and ranges", () => {
  it("ignores test files and reports no artifact change", () => {
    const { repo, base, head } = fixture({ "src/__tests__/server.test.ts": "export const x = 1\n" })
    assert.equal(classify(input(repo, base, head)).word, "no artifact change")
  })

  it("reports a change under an audit path only as local change", () => {
    const { repo, base, head } = fixture({ "cli/src/docker.ts": "export const image = 'y'\n" })
    assert.equal(classify(input(repo, base, head)).word, "local change (1 files)")
  })

  it("keeps a file with no class, such as .nvmrc", () => {
    const { repo, base, head } = fixture({ ".nvmrc": "25\n" })
    assert.equal(classify(input(repo, base, head)).outcome, "artifact change")
  })

  it("keeps a class the profile did not select", () => {
    const { repo, base, head } = fixture({ Dockerfile: DOCKERFILE.replace("sha256:aaa", "sha256:bbb") })
    const result = classify(input(repo, base, head, { exempt: ["dependency"] }))
    assert.equal(result.outcome, "artifact change")
    assert.match(firstReason(result), /not a selected exemption/)
  })

  it("compares trees in tested range, so a reset head is a change the pr range misses", () => {
    const { repo, base, head } = fixture({ "src/server.ts": SOURCE.replace("s.length", "s.length + 1") })
    // Compare the tested head with its own parent: the pr range sees nothing because the parent is an ancestor.
    assert.equal(classify(input(repo, head, base)).word, "no artifact change")
    assert.equal(classify(input(repo, head, base, { range: "tested" })).outcome, "artifact change")
  })

  it("throws a GitError on a commit git does not know", () => {
    const { repo, base } = fixture({ ".nvmrc": "25\n" })
    assert.throws(() => classify(input(repo, base, "0000000000000000000000000000000000000000")), GitError)
  })
})

describe("command line", () => {
  it("prints the outcome word and exits 2 on a git failure", () => {
    const { repo, base, head } = fixture({ "package.json": packageWith((p) => { p.dependencies.hono = "4.6.1" }) })
    const args = ["--repo", repo, "--from", base, "--to", head, "--exempt", "dependency,digest", "--live-test-package", "rrule", ...ARTIFACT_PATHSPECS.flatMap((spec) => ["--pathspec", spec])]
    const ok = spawnSync("bun", [SCRIPT_PATH, ...args], { encoding: "utf8" })
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.stdout.trim(), "exempt (dependency)")
    const bad = spawnSync("bun", [SCRIPT_PATH, "--repo", repo, "--from", base, "--to", "nope", "--pathspec", "src/"], { encoding: "utf8" })
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /git diff/)
  })
})
