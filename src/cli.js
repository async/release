#!/usr/bin/env node
import {
  changelogUpdate,
  checkChangelog,
  inspectPackage,
  inspectPreview,
  planRelease,
  planPreview,
  renderReleaseNotes,
  runDoctor,
  runPreviewDoctor,
  stagePreview,
  syncReleaseDescriptions
} from "./index.js";

const args = process.argv.slice(2);

try {
  const result = await run(args);
  if (result !== undefined) {
    if (flag(args, "--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(summary(result));
    }
  }
} catch (error) {
  process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function run(argv) {
  const [group, command] = argv;
  const options = optionsFromArgs(argv.slice(2));
  if (group === "package" && command === "plan") return planRelease(options);
  if (group === "package" && command === "inspect") return inspectPackage(options);
  if (group === "preview" && command === "plan") return planPreview(options);
  if (group === "preview" && command === "stage") return stagePreview(options);
  if (group === "preview" && command === "inspect") return inspectPreview(options);
  if (group === "preview" && command === "doctor") return runPreviewDoctor(options);
  if (group === "changelog" && command === "check") return checkChangelog(options);
  if (group === "changelog" && command === "update") return changelogUpdate(options);
  if (group === "notes" && command === "render") return renderReleaseNotes(options);
  if (group === "release" && command === "sync-descriptions") return syncReleaseDescriptions(options);
  if (group === "doctor") return runDoctor(optionsFromArgs(argv.slice(1)));
  throw new Error(usage());
}

function optionsFromArgs(argv) {
  return {
    packagePath: value(argv, "--package", "."),
    evidenceDir: value(argv, "--evidence-dir", ".async/release"),
    event: value(argv, "--event", undefined),
    releaseType: value(argv, "--release-type", undefined),
    expectedProfile: value(argv, "--expected-profile", value(argv, "--package-profile", undefined)),
    packageProfile: value(argv, "--package-profile", undefined),
    previousVersion: value(argv, "--previous-version", undefined),
    mode: value(argv, "--mode", undefined),
    registry: value(argv, "--registry", value(argv, "--target-registry", "https://npm.pkg.github.com")),
    namespace: value(argv, "--namespace", undefined),
    sourceRepository: value(argv, "--source-repository", value(argv, "--repository", undefined)),
    sourceSha: value(argv, "--source-sha", value(argv, "--sha", undefined)),
    prNumber: value(argv, "--pr-number", undefined),
    headSha: value(argv, "--head-sha", undefined),
    skipReason: value(argv, "--skip-reason", undefined),
    stageDir: value(argv, "--stage-dir", undefined),
    comment: !flag(argv, "--no-comment") && value(argv, "--comment", "true") !== "false",
    network: value(argv, "--network", "live"),
    repository: value(argv, "--repository", undefined),
    check: flag(argv, "--check"),
    verifyGitHubRelease: !flag(argv, "--no-github-release")
  };
}

function value(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const found = argv[index + 1];
  if (!found || found.startsWith("--")) throw new Error(`${name} needs a value.`);
  return found;
}

function flag(argv, name) {
  return argv.includes(name);
}

function summary(result) {
  if (result.releaseType) return `release plan: ${result.releaseType} (${result.publishOrder.join(", ")})\n`;
  if (result.preview && result.staging) return `preview stage: ${result.preview.packageSpec ?? "skipped"} -> ${result.staging.path}\n`;
  if (result.preview && result.inspection) return `preview inspection: ${result.preview.packageSpec ?? "skipped"} (${result.inspection.profile})\n`;
  if (result.preview && result.checks) return `preview doctor ${result.status}: ${result.preview.packageSpec ?? "skipped"}\n`;
  if (result.preview) return `preview plan: ${result.preview.packageSpec ?? "skipped"} (${result.preview.distTag ?? result.skip?.reason ?? "no tag"})\n`;
  if (result.bundleSizes) return `package inspection: ${result.package.name}@${result.package.version} (${result.package.profile})\n`;
  if (result.changelog) return `changelog ok: ${result.package.name}@${result.package.version}\n`;
  if (result.body) return `release notes: ${result.path}\n`;
  if (result.updated) return `release descriptions ${result.check ? "checked" : "synced"}: ${result.updated.length} updated, ${result.matching.length} matching, ${result.skipped.length} skipped\n`;
  if (result.checks) return `release doctor ${result.status}: ${result.package.name}@${result.package.version}\n`;
  return `${JSON.stringify(result)}\n`;
}

function usage() {
  return [
    "Usage:",
    "  async-release package plan --package <path> [--json] [--evidence-dir <dir>]",
    "  async-release package inspect --package <path> [--package-profile <profile>] [--json]",
    "  async-release preview plan --package <path> --mode pr|main --namespace <scope> --source-sha <sha> [--pr-number <n> --head-sha <sha>] [--json]",
    "  async-release preview stage --package <path> --mode pr|main --namespace <scope> --registry <url> [--json]",
    "  async-release preview inspect --package <path> --mode pr|main --namespace <scope> [--json]",
    "  async-release preview doctor --package <path> --mode pr|main --namespace <scope> --network live|mock [--json]",
    "  async-release changelog check --package <path> [--json]",
    "  async-release changelog update --package <path> [--json]",
    "  async-release notes render --package <path> [--json]",
    "  async-release release sync-descriptions --package <path> [--check] [--json]",
    "  async-release doctor --package <path> [--network live|mock] [--json]"
  ].join("\n");
}
