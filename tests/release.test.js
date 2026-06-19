import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkChangelog, inspectPackage, planRelease, renderReleaseNotes, runDoctor } from "../src/index.js";

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
