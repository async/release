import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkChangelog, inspectPackage, planRelease, renderReleaseNotes, runDoctor, syncReleaseDescriptions } from "../src/index.js";

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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
