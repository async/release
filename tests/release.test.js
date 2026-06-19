import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkChangelog,
  inspectPackage,
  inspectPreview,
  planPreview,
  planRelease,
  renderReleaseNotes,
  runDoctor,
  runPreviewDoctor,
  stagePreview,
  syncReleaseDescriptions
} from "../src/index.js";

test("package plan orders publishable workspace packages by internal dependency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-plan-"));
  try {
    writeJson(join(dir, "package.json"), { name: "workspace", version: "0.0.0", private: true, workspaces: ["packages/*"] });
    mkdirSync(join(dir, "packages/a"), { recursive: true });
    mkdirSync(join(dir, "packages/b"), { recursive: true });
    writeJson(join(dir, "packages/a/package.json"), { name: "@async/a", version: "1.0.0" });
    writeJson(join(dir, "packages/b/package.json"), { name: "@async/b", version: "1.0.0", dependencies: { "@async/a": "1.0.0" } });

    const plan = await planRelease({ cwd: dir, packagePath: "." });

    assert.equal(plan.releaseType, "monorepo-partial");
    assert.deepEqual(plan.publishOrder, ["@async/a", "@async/b"]);
    assert.equal(plan.tagStrategy, "package-name@version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("framework package inspection emits bundle sizes and diff links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-inspect-"));
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/framework",
      version: "0.11.3",
      type: "module",
      repository: { type: "git", url: "git+https://github.com/async/framework.git" },
      exports: { ".": { browser: "./browser.js", default: "./server.js" }, "./server": "./server.js" },
      browser: "./browser.js",
      unpkg: "./browser.min.js",
      jsdelivr: "./browser.min.js",
      files: ["browser.js", "browser.min.js", "server.js"]
    });
    writeFileSync(join(dir, "browser.js"), "export const runtime = 'browser';\n", "utf8");
    writeFileSync(join(dir, "browser.min.js"), "export const runtime='browser';\n", "utf8");
    writeFileSync(join(dir, "server.js"), "export const runtime = 'server';\n", "utf8");

    const report = await inspectPackage({ cwd: dir, expectedProfile: "framework-browser", previousVersion: "0.11.2" });

    assert.equal(report.package.profile, "framework-browser");
    assert.ok(report.bundleSizes.some((row) => row.file === "browser.js"));
    assert.ok(report.diffLinks.some((entry) => entry.file === "browser.js" && entry.url.includes("async/framework")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changelog check and notes render write package evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-notes-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/release", version: "0.1.0", files: ["index.js"] });
    writeFileSync(join(dir, "index.js"), "export {};\n", "utf8");
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0 - 2026-06-19\n\n- Initial release.\n", "utf8");

    const changelog = await checkChangelog({ cwd: dir });
    const notes = await renderReleaseNotes({ cwd: dir });

    assert.equal(changelog.changelog.tagName, "v0.1.0");
    assert.match(notes.body, /Initial release/u);
    assert.match(readFileSync(join(dir, ".async/release/release-notes.md"), "utf8"), /Release evidence/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor mock mode writes bounded local evidence without network commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-doctor-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/release", version: "0.1.0" });

    const result = await runDoctor({ cwd: dir, network: "mock" });

    assert.equal(result.status, "pass");
    assert.equal(result.checks.every((check) => check.status === "mocked"), true);
    assert.match(readFileSync(join(dir, ".async/release/doctor.json"), "utf8"), /"network": "mock"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview plan emits deterministic PR identity and bounded install comment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-plan-pr-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/example", version: "1.2.3" });

    const plan = await planPreview({
      cwd: dir,
      mode: "pr",
      namespace: "async",
      sourceRepository: "async/example",
      sourceSha: "base123",
      prNumber: 12,
      headSha: "abc123"
    });

    assert.equal(plan.preview.mirrorPackageName, "@async/example");
    assert.equal(plan.preview.version, "0.0.0-pr.12.sha.abc123");
    assert.equal(plan.preview.distTag, "pr-12");
    assert.equal(plan.preview.packageSpec, "@async/example@0.0.0-pr.12.sha.abc123");
    assert.equal(plan.install.target, "@async/example@pr-12");
    assert.match(plan.install.commentBody, /Preview for PR head `abc123`/u);
    assert.match(plan.install.commentBody, /pnpm add @async\/example@pr-12/u);
    assert.match(readFileSync(join(dir, ".async/release/preview-install.json"), "utf8"), /async-actions-package-preview/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview plan emits deterministic main identity and mirror aliases for unscoped packages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-plan-main-"));
  try {
    writeJson(join(dir, "package.json"), { name: "plain-package", version: "1.2.3" });

    const plan = await planPreview({
      cwd: dir,
      mode: "main",
      namespace: "@Async-Preview",
      sourceRepository: "async/plain-package",
      sourceSha: "def456"
    });

    assert.equal(plan.preview.mirrorPackageName, "@async-preview/plain-package");
    assert.equal(plan.preview.version, "0.0.0-main.sha.def456");
    assert.equal(plan.preview.distTag, "main");
    assert.equal(plan.install.target, "plain-package@npm:@async-preview/plain-package@main");
    assert.match(plan.install.command, /^pnpm add plain-package@npm:@async-preview\/plain-package@main$/u);
    assert.equal(plan.install.commentBody, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview stage writes deterministic publish manifest and pack files without credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-stage-"));
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/example",
      version: "1.2.3",
      files: ["dist"],
      scripts: { prepublishOnly: "node secret.js" },
      devDependencies: { fixture: "1.0.0" }
    });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "export const ok = true;\n", "utf8");

    const result = await stagePreview({
      cwd: dir,
      mode: "pr",
      namespace: "async",
      registry: "https://npm.pkg.github.com",
      prNumber: 12,
      headSha: "abc123",
      sourceSha: "base123"
    });

    assert.equal(result.staging.path, ".async/release/preview-stage");
    const manifest = JSON.parse(readFileSync(join(dir, ".async/release/preview-stage/package.json"), "utf8"));
    assert.equal(manifest.name, "@async/example");
    assert.equal(manifest.version, "0.0.0-pr.12.sha.abc123");
    assert.deepEqual(manifest.publishConfig, { registry: "https://npm.pkg.github.com" });
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.match(readFileSync(join(dir, ".async/release/preview-stage/dist/index.js"), "utf8"), /ok/u);
    assert.deepEqual(result.staging.removedFields, ["scripts", "devDependencies"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview inspect reuses package profile, pack, bundle, and diff evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-inspect-"));
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/framework",
      version: "0.11.3",
      type: "module",
      repository: { type: "git", url: "git+https://github.com/async/framework.git" },
      exports: { ".": { browser: "./browser.js", default: "./server.js" }, "./server": "./server.js" },
      browser: "./browser.js",
      files: ["browser.js", "server.js"]
    });
    writeFileSync(join(dir, "browser.js"), "export const runtime = 'browser';\n", "utf8");
    writeFileSync(join(dir, "server.js"), "export const runtime = 'server';\n", "utf8");

    const result = await inspectPreview({
      cwd: dir,
      mode: "main",
      namespace: "async",
      sourceSha: "def456",
      previousVersion: "0.11.2"
    });

    assert.equal(result.inspection.profile, "framework-browser");
    assert.ok(result.inspection.pack.files.includes("browser.js"));
    assert.ok(result.inspection.bundleSizes.some((row) => row.file === "browser.js"));
    assert.ok(result.inspection.diffLinks.some((entry) => entry.url.includes("async/framework")));
    assert.match(readFileSync(join(dir, ".async/release/preview-inspect.json"), "utf8"), /preview-plan\.json/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview doctor mock mode writes bounded local evidence without network commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-doctor-mock-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/example", version: "1.2.3" });

    const result = await runPreviewDoctor({
      cwd: dir,
      mode: "pr",
      namespace: "async",
      network: "mock",
      prNumber: 12,
      headSha: "abc123",
      sourceSha: "base123"
    });

    assert.equal(result.status, "pass");
    assert.equal(result.checks.every((check) => check.status === "mocked"), true);
    assert.match(readFileSync(join(dir, ".async/release/preview-doctor.json"), "utf8"), /"network": "mock"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview doctor live mode verifies immutable version and dist-tag with npm commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-doctor-live-"));
  const originalPath = process.env.PATH;
  try {
    writeJson(join(dir, "package.json"), { name: "@async/example", version: "1.2.3" });
    const binDir = join(dir, "bin");
    const callsPath = join(dir, "npm-calls.jsonl");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "npm"), fakePreviewNpm(callsPath, "0.0.0-pr.12.sha.abc123"), "utf8");
    chmodSync(join(binDir, "npm"), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    const result = await runPreviewDoctor({
      cwd: dir,
      mode: "pr",
      namespace: "async",
      network: "live",
      registry: "https://npm.pkg.github.com",
      prNumber: 12,
      headSha: "abc123",
      sourceSha: "base123"
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(result.checks.map((check) => check.name), ["preview-version", "preview-dist-tag"]);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
      ["view", "@async/example@0.0.0-pr.12.sha.abc123", "version"],
      ["view", "@async/example", "dist-tags.pr-12"]
    ]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview doctor live mode authenticates GitHub Packages reads with workflow token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-doctor-auth-"));
  const originalPath = process.env.PATH;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalNodeToken = process.env.NODE_AUTH_TOKEN;
  try {
    writeJson(join(dir, "package.json"), { name: "@async/example", version: "1.2.3" });
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const callsPath = join(dir, "npm-calls.jsonl");
    writeFileSync(join(binDir, "npm"), fakePreviewNpm(callsPath, "0.0.0-pr.12.sha.abc123"), "utf8");
    chmodSync(join(binDir, "npm"), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.GITHUB_TOKEN = "fake-github-token";
    process.env.NODE_AUTH_TOKEN = "wrong-node-token";

    const result = await runPreviewDoctor({
      cwd: dir,
      mode: "pr",
      namespace: "async",
      network: "live",
      registry: "https://npm.pkg.github.com",
      prNumber: 12,
      headSha: "abc123",
      sourceSha: "base123"
    });

    assert.equal(result.status, "pass");
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.userconfig.includes("async-release-npmrc-")));
    assert.ok(calls.every((call) => call.nodeAuthToken === "fake-github-token"));
  } finally {
    process.env.PATH = originalPath;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalNodeToken === undefined) {
      delete process.env.NODE_AUTH_TOKEN;
    } else {
      process.env.NODE_AUTH_TOKEN = originalNodeToken;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview plan records explicit skip evidence for fork PR callers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-skip-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/example", version: "1.2.3" });

    const plan = await planPreview({
      cwd: dir,
      mode: "pr",
      namespace: "async",
      sourceRepository: "async/example",
      skipReason: "pull request head repository is a fork"
    });

    assert.equal(plan.skip.shouldSkip, true);
    assert.equal(plan.skip.reason, "pull request head repository is a fork");
    assert.equal(plan.preview.version, null);
    assert.match(readFileSync(join(dir, ".async/release/preview-plan.json"), "utf8"), /pull request head repository is a fork/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release description sync patches stale semver GitHub Release notes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-sync-"));
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/release",
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/async/release.git" }
    });
    writeFileSync(join(dir, "CHANGELOG.md"), [
      "# Changelog",
      "",
      "## 0.1.0 - 2026-06-19",
      "",
      "- Initial release.",
      "",
      "## 0.0.9 - 2026-06-18",
      "",
      "- Historical release.",
      ""
    ].join("\n"), "utf8");
    const github = fakeGitHub([
      { tagName: "v0.1.0", body: "stale" },
      { tagName: "v0.0.9", body: releaseBody("0.0.9", "2026-06-18", "- Historical release.") },
      { tagName: "nightly", body: "custom" }
    ]);

    const result = await syncReleaseDescriptions({ cwd: dir, github });

    assert.deepEqual(result.updated, [{ tagName: "v0.1.0" }]);
    assert.deepEqual(result.matching, [{ tagName: "v0.0.9" }]);
    assert.deepEqual(result.skipped, [{ tagName: "nightly", reason: "non-semver" }]);
    assert.equal(github.updates.get("v0.1.0"), releaseBody("0.1.0", "2026-06-19", "- Initial release."));
    assert.match(readFileSync(join(dir, ".async/release/release-description-sync.json"), "utf8"), /"v0.1.0"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release description sync check reports drift without patching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-sync-check-"));
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/release",
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/async/release.git" }
    });
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0 - 2026-06-19\n\n- Initial release.\n", "utf8");
    const github = fakeGitHub([{ tagName: "v0.1.0", body: "stale" }]);

    await assert.rejects(
      syncReleaseDescriptions({ cwd: dir, github, check: true }),
      /GitHub Release descriptions do not match CHANGELOG\.md: v0\.1\.0 body differs/u
    );
    assert.equal(github.updates.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release description sync fails when a semver release lacks a changelog section", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-sync-missing-changelog-"));
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/release",
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/async/release.git" }
    });
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0 - 2026-06-19\n\n- Initial release.\n", "utf8");
    const github = fakeGitHub([{ tagName: "v9.9.9", body: "orphan" }]);

    await assert.rejects(
      syncReleaseDescriptions({ cwd: dir, github }),
      /v9\.9\.9 has no parseable, non-empty CHANGELOG\.md section/u
    );
    assert.equal(github.updates.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release description sync uses REST releases API for list and update", async () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-rest-sync-"));
  const originalPath = process.env.PATH;
  try {
    writeJson(join(dir, "package.json"), {
      name: "@async/release",
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/async/release.git" }
    });
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0 - 2026-06-19\n\n- Initial release.\n", "utf8");
    const binDir = join(dir, "bin");
    const callsPath = join(dir, "gh-calls.jsonl");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "gh"), fakeGhScript(callsPath), "utf8");
    chmodSync(join(binDir, "gh"), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    const result = await syncReleaseDescriptions({ cwd: dir });

    assert.deepEqual(result.updated, [{ tagName: "v0.1.0" }]);
    assert.deepEqual(result.skipped, [{ tagName: "nightly", reason: "non-semver" }]);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].args.slice(0, 4), ["api", "repos/async/release/releases?per_page=100", "--paginate", "--jq"]);
    assert.deepEqual(calls[1].args.slice(0, 4), ["api", "--method", "PATCH", "repos/async/release/releases/123"]);
    assert.equal(calls[1].body, releaseBody("0.1.0", "2026-06-19", "- Initial release."));
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exposes JSON command output", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-cli-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/release", version: "0.1.0" });
    const result = spawnSync(process.execPath, [new URL("../src/cli.js", import.meta.url).pathname, "package", "plan", "--json"], {
      cwd: dir,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).publishOrder[0], "@async/release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exposes preview JSON command output", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-release-preview-cli-"));
  try {
    writeJson(join(dir, "package.json"), { name: "@async/example", version: "1.2.3" });
    const result = spawnSync(process.execPath, [
      new URL("../src/cli.js", import.meta.url).pathname,
      "preview",
      "plan",
      "--mode",
      "pr",
      "--namespace",
      "async",
      "--pr-number",
      "12",
      "--head-sha",
      "abc123",
      "--source-sha",
      "base123",
      "--json"
    ], {
      cwd: dir,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).preview.packageSpec, "@async/example@0.0.0-pr.12.sha.abc123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fakeGhScript(callsPath) {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const callsPath = ${JSON.stringify(callsPath)};
const args = process.argv.slice(2);
let body;
const inputIndex = args.indexOf("--input");
if (inputIndex !== -1) {
  body = JSON.parse(readFileSync(args[inputIndex + 1], "utf8")).body;
}

appendFileSync(callsPath, JSON.stringify({ args, body }) + "\\n");

if (args[0] === "api" && args[1] === "repos/async/release/releases?per_page=100") {
  process.stdout.write(JSON.stringify({ id: 123, tagName: "v0.1.0", body: "stale" }) + "\\n");
  process.stdout.write(JSON.stringify({ id: 124, tagName: "nightly", body: "custom" }) + "\\n");
} else if (args[0] === "api" && args[1] === "--method" && args[2] === "PATCH" && args[3] === "repos/async/release/releases/123") {
  process.stdout.write("{}\\n");
} else {
  process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
  process.exit(1);
}
`;
}

function fakePreviewNpm(callsPath, version) {
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, userconfig: process.env.NPM_CONFIG_USERCONFIG || "", nodeAuthToken: process.env.NODE_AUTH_TOKEN || "" }) + "\\n");

if (args[0] === "view" && args[2] === "version") {
  process.stdout.write(${JSON.stringify(version)} + "\\n");
} else if (args[0] === "view" && args[2] === "dist-tags.pr-12") {
  process.stdout.write(${JSON.stringify(version)} + "\\n");
} else {
  process.stderr.write("unexpected npm args: " + args.join(" ") + "\\n");
  process.exit(1);
}
`;
}

function fakeGitHub(releases) {
  const updates = new Map();
  return {
    updates,
    async listReleases() {
      return releases;
    },
    async updateReleaseBody(tagName, body) {
      updates.set(tagName, body);
    }
  };
}

function releaseBody(version, date, body) {
  return [
    `Release notes from \`CHANGELOG.md\` for ${version} (${date}).`,
    "",
    body,
    "",
    "---",
    `Source: \`CHANGELOG.md\` in tag \`v${version}\`.`,
    ""
  ].join("\n");
}
