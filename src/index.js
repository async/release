import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { brotliCompressSync, gzipSync } from "node:zlib";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_EVIDENCE_DIR = ".async/release";
const JS_FILE_PATTERN = /\.(?:cjs|js|jsx|ts|tsx)$/;

export async function planRelease(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const packagePath = options.packagePath ?? ".";
  const event = options.event ?? process.env.GITHUB_EVENT_NAME ?? "local";
  const explicitType = options.releaseType ?? process.env.ASYNC_RELEASE_TYPE ?? "auto";
  const packages = await discoverPublishablePackages(cwd, packagePath);
  const publishOrder = orderPackages(packages);
  const releaseType = determineReleaseType(explicitType, event, publishOrder);
  const tagStrategy = publishOrder.length > 1 ? "package-name@version" : "vX.Y.Z";
  const result = {
    schemaVersion: 1,
    releaseType: releaseType.type,
    reason: releaseType.reason,
    event,
    tagStrategy,
    publishOrder: publishOrder.map((entry) => entry.name),
    packages: publishOrder.map((entry) => ({
      name: entry.name,
      version: entry.version,
      packagePath: entry.packagePath,
      private: entry.private === true,
      dependencies: entry.internalDependencies
    }))
  };
  await writeEvidence(cwd, options.evidenceDir, "package-plan.json", result);
  return result;
}

export async function inspectPackage(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const pack = readPackFiles(context.packageDir);
  const profile = classifyPackage(context.manifest, pack.files, context.packageDir);
  const expectedProfile = options.expectedProfile ?? options.packageProfile;
  if (expectedProfile && expectedProfile !== profile) {
    throw new Error(`${context.manifest.name} looks like ${profile}, not expected profile ${expectedProfile}.`);
  }
  const bundleSizes = await bundleSizeEvidence(context.packageDir, pack.files);
  const diffLinks = releaseDiffLinks(context.manifest, bundleSizes.map((entry) => entry.file), options.previousVersion);
  const result = {
    schemaVersion: 1,
    package: {
      name: context.manifest.name,
      version: context.manifest.version,
      packagePath: relativePath(cwd, context.packageDir),
      profile
    },
    metadata: {
      exports: context.manifest.exports ?? null,
      main: context.manifest.main ?? null,
      module: context.manifest.module ?? null,
      browser: context.manifest.browser ?? null,
      unpkg: context.manifest.unpkg ?? null,
      jsdelivr: context.manifest.jsdelivr ?? null,
      bin: context.manifest.bin ?? null,
      files: Array.isArray(context.manifest.files) ? context.manifest.files : null
    },
    pack,
    bundleSizes,
    diffLinks
  };
  await writeEvidence(cwd, options.evidenceDir, "package-report.json", result);
  return result;
}

export async function planPreview(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const plan = previewPlanFromContext(cwd, context, options);
  await writeEvidence(cwd, options.evidenceDir, "preview-plan.json", plan);
  if (!plan.skip.shouldSkip) {
    await writeEvidence(cwd, options.evidenceDir, "preview-install.json", {
      schemaVersion: 1,
      package: plan.package,
      preview: plan.preview,
      install: plan.install
    });
  }
  return plan;
}

export async function stagePreview(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const plan = previewPlanFromContext(cwd, context, options);
  if (plan.skip.shouldSkip) {
    const result = {
      schemaVersion: 1,
      package: plan.package,
      preview: plan.preview,
      skip: plan.skip,
      staged: false,
      reason: plan.skip.reason
    };
    await writeEvidence(cwd, options.evidenceDir, "preview-stage.json", result);
    return result;
  }

  const pack = readPackFiles(context.packageDir);
  const stageDir = resolveInside(cwd, options.stageDir ?? join(options.evidenceDir ?? DEFAULT_EVIDENCE_DIR, "preview-stage"));
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  await copyPackFiles(context.packageDir, stageDir, pack.files);
  const stagedManifest = previewManifest(context.manifest, plan, options.registry);
  await writeFile(join(stageDir, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`, "utf8");

  const result = {
    schemaVersion: 1,
    package: plan.package,
    preview: plan.preview,
    staging: {
      path: relativePath(cwd, stageDir),
      manifestPath: relativePath(cwd, join(stageDir, "package.json")),
      publishConfig: stagedManifest.publishConfig,
      removedFields: ["scripts", "devDependencies"].filter((field) => context.manifest[field] !== undefined),
      files: pack.files
    }
  };
  await writeEvidence(cwd, options.evidenceDir, "preview-stage.json", result);
  return result;
}

export async function inspectPreview(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const plan = await planPreview(options);
  const report = await inspectPackage(options);
  const result = {
    schemaVersion: 1,
    package: report.package,
    preview: plan.preview,
    skip: plan.skip,
    inspection: {
      profile: report.package.profile,
      pack: report.pack,
      bundleSizes: report.bundleSizes,
      diffLinks: report.diffLinks,
      evidence: {
        packageReport: evidencePath(cwd, options.evidenceDir, "package-report.json"),
        previewPlan: evidencePath(cwd, options.evidenceDir, "preview-plan.json")
      }
    }
  };
  await writeEvidence(cwd, options.evidenceDir, "preview-inspect.json", result);
  return result;
}

export async function runPreviewDoctor(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const plan = previewPlanFromContext(cwd, context, options);
  const network = options.network ?? "live";
  const checks = [];
  const addCheck = (name, status, details = {}) => {
    checks.push({ name, status, ...details });
  };

  if (plan.skip.shouldSkip) {
    addCheck("preview-skip", "skip", { reason: plan.skip.reason });
  } else if (network === "mock") {
    addCheck("preview-version", "mocked", { spec: plan.preview.packageSpec });
    addCheck("preview-dist-tag", "mocked", { package: plan.preview.mirrorPackageName, distTag: plan.preview.distTag, expectedVersion: plan.preview.version });
    addCheck("preview-install", "mocked", { target: plan.install.target });
  } else {
    verifyPreviewNpm(plan, addCheck, options.registry);
  }

  const failed = checks.filter((check) => check.status === "fail");
  const result = {
    schemaVersion: 1,
    package: plan.package,
    preview: plan.preview,
    network,
    status: failed.length > 0 ? "fail" : "pass",
    checks
  };
  await writeEvidence(cwd, options.evidenceDir, "preview-doctor.json", result);
  if (failed.length > 0) {
    throw new Error(`Preview doctor failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  return result;
}

export async function checkChangelog(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const notes = await readChangelogReleaseNotes(cwd);
  const note = notes.get(`v${context.manifest.version}`);
  if (!note) {
    throw new Error(`CHANGELOG.md has no parseable, non-empty "## ${context.manifest.version} - <date>" entry.`);
  }
  const warnings = [];
  const expectedProfile = options.expectedProfile ?? options.packageProfile;
  if (expectedProfile === "framework-browser" && !/(bundle|gzip|brotli|size)/i.test(note.body)) {
    warnings.push("framework-browser release notes should include bundle size evidence.");
  }
  const result = {
    schemaVersion: 1,
    package: {
      name: context.manifest.name,
      version: context.manifest.version
    },
    changelog: {
      tagName: note.tagName,
      date: note.date,
      body: note.body,
      releaseBody: note.releaseBody
    },
    warnings
  };
  await writeEvidence(cwd, options.evidenceDir, "changelog-check.json", result);
  return result;
}

export async function renderReleaseNotes(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const changelog = await checkChangelog({ ...options, cwd, packagePath: options.packagePath ?? "." });
  const report = await loadPackageReport(cwd, options.evidenceDir).catch(() => undefined);
  const plan = await loadPackagePlan(cwd, options.evidenceDir).catch(() => undefined);
  const body = [
    `Release notes from \`CHANGELOG.md\` for ${context.manifest.name}@${context.manifest.version} (${changelog.changelog.date}).`,
    "",
    changelog.changelog.body,
    "",
    "## Release evidence",
    "",
    `- Release type: ${plan?.releaseType ?? options.releaseType ?? "stable"}`,
    `- Package profile: ${report?.package?.profile ?? "unknown"}`,
    `- npm pack files: ${report?.pack?.files?.length ?? "not inspected"}`,
    ...(report?.bundleSizes?.length > 0 ? ["", ...renderBundleTable(report.bundleSizes)] : []),
    ...(report?.diffLinks?.length > 0 ? ["", "Diff links:", ...report.diffLinks.map((entry) => `- ${entry.file}: ${entry.url}`)] : []),
    "",
    "---",
    `Source: \`CHANGELOG.md\` in tag \`v${context.manifest.version}\`.`,
    ""
  ].join("\n");
  const result = {
    schemaVersion: 1,
    package: {
      name: context.manifest.name,
      version: context.manifest.version
    },
    path: evidencePath(cwd, options.evidenceDir, "release-notes.md"),
    body
  };
  await writeEvidenceText(cwd, options.evidenceDir, "release-notes.md", body);
  await writeEvidence(cwd, options.evidenceDir, "release-notes.json", result);
  return result;
}

export async function runDoctor(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const network = options.network ?? "live";
  const checks = [];
  const addCheck = (name, status, details = {}) => {
    checks.push({ name, status, ...details });
  };

  if (network === "mock") {
    addCheck("npm", "mocked", { spec: `${context.manifest.name}@${context.manifest.version}` });
    addCheck("github-release", "mocked", { tagName: `v${context.manifest.version}` });
    addCheck("release-notes", "mocked");
  } else {
    await verifyNpm(context, addCheck);
    if (options.verifyGitHubRelease !== false) {
      verifyGitHubRelease(context, options.repository, addCheck);
    }
  }

  const failed = checks.filter((check) => check.status === "fail");
  const result = {
    schemaVersion: 1,
    package: {
      name: context.manifest.name,
      version: context.manifest.version
    },
    network,
    status: failed.length > 0 ? "fail" : "pass",
    checks
  };
  await writeEvidence(cwd, options.evidenceDir, "doctor.json", result);
  if (failed.length > 0) {
    throw new Error(`Release doctor failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  return result;
}

export async function changelogUpdate(options = {}) {
  const result = await checkChangelog(options);
  return {
    ...result,
    updated: false,
    reason: "No generated changelog section was requested."
  };
}

export async function syncReleaseDescriptions(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = await readPackageContext(cwd, options.packagePath ?? ".");
  const repository = options.repository ?? packageRepositoryName(context.manifest) ?? process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("Set --repository, GITHUB_REPOSITORY, or package.json repository so release descriptions can resolve GitHub state.");
  }

  const notes = await readChangelogReleaseNotes(cwd);
  const github = options.github ?? createGitHubReleaseClient({ cwd, repository });
  const releases = await github.listReleases();
  const result = {
    schemaVersion: 1,
    package: {
      name: context.manifest.name,
      version: context.manifest.version
    },
    repository,
    check: options.check === true,
    updated: [],
    matching: [],
    skipped: [],
    drift: []
  };

  for (const release of releases) {
    const tagName = String(release.tagName ?? release.tag_name ?? "");
    if (!isSemverTag(tagName)) {
      result.skipped.push({ tagName, reason: "non-semver" });
      continue;
    }
    const note = notes.get(tagName);
    if (!note) {
      throw new Error(`${tagName} has no parseable, non-empty CHANGELOG.md section.`);
    }
    const currentBody = String(release.body ?? "");
    if (currentBody === note.releaseBody) {
      result.matching.push({ tagName });
      continue;
    }
    result.drift.push({ tagName, reason: "body differs" });
    if (!options.check) {
      await github.updateReleaseBody(tagName, note.releaseBody);
      result.updated.push({ tagName });
    }
  }

  await writeEvidence(cwd, options.evidenceDir, "release-description-sync.json", result);
  if (options.check && result.drift.length > 0) {
    throw new Error(`GitHub Release descriptions do not match CHANGELOG.md: ${result.drift.map((entry) => `${entry.tagName} ${entry.reason}`).join(", ")}`);
  }
  return result;
}

async function discoverPublishablePackages(cwd, packagePath) {
  const root = await readPackageContext(cwd, packagePath);
  if (!root.manifest.private) {
    return [packageEntry(cwd, root.packageDir, root.manifest, [])];
  }
  const patterns = workspacePatterns(root.manifest, await readTextIfExists(join(root.packageDir, "pnpm-workspace.yaml")));
  const entries = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const base = resolveInside(root.packageDir, pattern.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const child of await readdir(base, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const manifestPath = join(base, child.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.private || typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
      entries.push(packageEntry(cwd, join(base, child.name), manifest, []));
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  return entries.map((entry) => ({
    ...entry,
    internalDependencies: Object.keys({
      ...(entry.manifest.dependencies ?? {}),
      ...(entry.manifest.peerDependencies ?? {}),
      ...(entry.manifest.optionalDependencies ?? {})
    }).filter((name) => names.has(name)).sort()
  }));
}

function packageEntry(cwd, packageDir, manifest, internalDependencies) {
  return {
    name: manifest.name,
    version: manifest.version,
    private: manifest.private === true,
    packagePath: relativePath(cwd, packageDir),
    manifest,
    internalDependencies
  };
}

function workspacePatterns(manifest, workspaceYaml) {
  const patterns = [];
  if (Array.isArray(manifest.workspaces)) patterns.push(...manifest.workspaces);
  if (manifest.workspaces && Array.isArray(manifest.workspaces.packages)) patterns.push(...manifest.workspaces.packages);
  if (workspaceYaml) {
    for (const line of workspaceYaml.split(/\r?\n/u)) {
      const match = /^\s*-\s*["']?([^"']+)["']?\s*$/u.exec(line);
      if (match) patterns.push(match[1]);
    }
  }
  return [...new Set(patterns)];
}

function orderPackages(packages) {
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const visited = new Set();
  const ordered = [];
  const visit = (entry) => {
    if (visited.has(entry.name)) return;
    visited.add(entry.name);
    for (const dependency of entry.internalDependencies ?? []) {
      const dependencyEntry = byName.get(dependency);
      if (dependencyEntry) visit(dependencyEntry);
    }
    ordered.push(entry);
  };
  for (const entry of [...packages].sort((left, right) => left.name.localeCompare(right.name))) {
    visit(entry);
  }
  return ordered;
}

function determineReleaseType(explicitType, event, packages) {
  if (explicitType && explicitType !== "auto") {
    return { type: explicitType, reason: `release type was explicitly set to ${explicitType}` };
  }
  if (process.env.ASYNC_RELEASE_MODE === "doctor") {
    return { type: "doctor-only", reason: "ASYNC_RELEASE_MODE=doctor" };
  }
  if (process.env.ASYNC_RELEASE_MODE === "notes") {
    return { type: "notes-only", reason: "ASYNC_RELEASE_MODE=notes" };
  }
  if (packages.length > 1) {
    return { type: "monorepo-partial", reason: `${packages.length} publishable workspace packages were selected` };
  }
  if (event === "release") {
    return { type: "stable", reason: "GitHub release event selected stable release" };
  }
  return { type: "stable", reason: `package version ${packages[0]?.version ?? "unknown"} selected for stable release` };
}

async function readPackageContext(cwd, packagePath) {
  const packageDir = resolveInside(cwd, packagePath);
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`${relativePath(cwd, packageDir)}/package.json must include name and version.`);
  }
  return { packageDir, manifest };
}

function readPackFiles(packageDir) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(packageDir, ".async", "npm-cache")
    }
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  }
  const packs = JSON.parse(result.stdout);
  const files = packs?.[0]?.files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run returned no file list.");
  }
  return {
    packageName: packs[0]?.filename ?? null,
    size: packs[0]?.size ?? null,
    unpackedSize: packs[0]?.unpackedSize ?? null,
    files: files.map((entry) => entry.path).filter((path) => typeof path === "string").sort()
  };
}

function classifyPackage(manifest, files, packageDir) {
  if (manifest.private) return "workspace-root";
  if (manifest.bin) return "cli";
  if (files.some((file) => file.includes("api-contract") || file.endsWith(".schema.json"))) return "contract-schema";
  const hasFrameworkTargets = Boolean(manifest.browser && manifest.exports && JSON.stringify(manifest.exports).includes("server"));
  if (hasFrameworkTargets || existsSync(join(packageDir, "framework.ts"))) return "framework-browser";
  if (manifest.browser || manifest.unpkg || manifest.jsdelivr || files.some((file) => file.includes("browser") && JS_FILE_PATTERN.test(file))) {
    return "browser-bundle";
  }
  return "node-library";
}

async function bundleSizeEvidence(packageDir, files) {
  const candidates = files
    .filter((file) => JS_FILE_PATTERN.test(file))
    .filter((file) => /(^|\/)(browser|framework|dist|umd|esm|index|main|server)/i.test(file))
    .slice(0, 40);
  const rows = [];
  for (const file of candidates) {
    const path = join(packageDir, file);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const buffer = await readFile(path);
    rows.push({
      file,
      rawBytes: buffer.byteLength,
      gzipBytes: gzipSync(buffer).byteLength,
      brotliBytes: brotliCompressSync(buffer).byteLength,
      raw: displayBytes(buffer.byteLength),
      gzip: displayBytes(gzipSync(buffer).byteLength),
      brotli: displayBytes(brotliCompressSync(buffer).byteLength)
    });
  }
  return rows;
}

function releaseDiffLinks(manifest, files, previousVersion) {
  const repository = packageRepositoryName(manifest);
  if (!repository || files.length === 0) return [];
  const from = previousVersion ? `v${previousVersion}` : "HEAD^";
  const to = `v${manifest.version}`;
  return files
    .filter((file) => !file.includes(".min."))
    .slice(0, 10)
    .map((file) => ({
      file,
      url: `https://github.com/${repository}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}?diff=unified#diff-${encodeURIComponent(file)}`
    }));
}

function previewPlanFromContext(cwd, context, options) {
  const mode = options.mode ?? "pr";
  if (mode !== "pr" && mode !== "main") {
    throw new Error(`Unsupported preview mode ${mode}. Use pr or main.`);
  }
  const namespace = normalizeNamespace(options.namespace);
  if (!namespace) {
    throw new Error("Preview planning needs --namespace.");
  }
  const sourceSha = options.sourceSha ?? process.env.GITHUB_SHA;
  const sourceRepository = options.sourceRepository ?? options.repository ?? process.env.GITHUB_REPOSITORY;
  const prNumber = numberOption(options.prNumber);
  const pullRequestHeadSha = options.headSha ?? options.pullRequestHeadSha;
  const skipReason = options.skipReason;
  const leaf = packageLeaf(context.manifest.name);
  const mirrorPackageName = `@${namespace}/${leaf}`;
  const preview = {
    mode,
    sourceRepository: sourceRepository ?? null,
    sourceSha: sourceSha ?? null,
    pullRequestNumber: mode === "pr" ? prNumber : null,
    pullRequestHeadSha: mode === "pr" ? pullRequestHeadSha ?? null : null,
    mirrorNamespace: namespace,
    mirrorPackageName,
    version: null,
    distTag: null,
    packageSpec: null
  };
  const result = {
    schemaVersion: 1,
    package: {
      name: context.manifest.name,
      version: context.manifest.version,
      packagePath: relativePath(cwd, context.packageDir)
    },
    preview,
    skip: {
      shouldSkip: Boolean(skipReason),
      reason: skipReason ?? null
    },
    install: null
  };
  if (skipReason) return result;
  if (mode === "main") {
    if (!sourceSha) throw new Error("Main preview planning needs --source-sha or GITHUB_SHA.");
    preview.version = `0.0.0-main.sha.${sourceSha}`;
    preview.distTag = "main";
  } else {
    if (!Number.isInteger(prNumber) || prNumber <= 0 || !pullRequestHeadSha) {
      throw new Error("PR preview planning needs --pr-number and --head-sha.");
    }
    preview.version = `0.0.0-pr.${prNumber}.sha.${pullRequestHeadSha}`;
    preview.distTag = `pr-${prNumber}`;
  }
  preview.packageSpec = `${mirrorPackageName}@${preview.version}`;
  result.install = previewInstall(context.manifest.name, mirrorPackageName, preview.distTag, pullRequestHeadSha ?? sourceSha, mode === "pr" && options.comment !== false);
  return result;
}

function previewInstall(sourceName, mirrorName, distTag, sourceSha, shouldComment) {
  const target = mirrorName === sourceName ? `${mirrorName}@${distTag}` : `${sourceName}@npm:${mirrorName}@${distTag}`;
  const command = `pnpm add ${target}`;
  const commentMarker = "async-actions-package-preview";
  const commentBody = shouldComment
    ? [
        "### Preview package",
        "",
        `Preview for PR head \`${sourceSha}\`, published as \`${mirrorName}\`.`,
        "",
        "```sh",
        command,
        "```"
      ].join("\n")
    : "";
  return {
    target,
    command,
    commentMarker,
    commentBody
  };
}

function previewManifest(manifest, plan, registry) {
  const staged = {
    ...manifest,
    name: plan.preview.mirrorPackageName,
    version: plan.preview.version,
    publishConfig: { registry: registry ?? "https://npm.pkg.github.com" }
  };
  delete staged.scripts;
  delete staged.devDependencies;
  return staged;
}

async function copyPackFiles(packageDir, stageDir, files) {
  for (const file of files) {
    if (file === "package.json") continue;
    const source = resolveInside(packageDir, file);
    if (!existsSync(source)) continue;
    const target = resolveInside(stageDir, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

function verifyPreviewNpm(plan, addCheck, registry = "https://npm.pkg.github.com") {
  const versionResult = spawnSync("npm", ["view", plan.preview.packageSpec, "version", "--registry", registry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (versionResult.status === 0 && versionResult.stdout.trim() === plan.preview.version) {
    addCheck("preview-version", "pass", { spec: plan.preview.packageSpec });
  } else {
    addCheck("preview-version", "fail", { spec: plan.preview.packageSpec, output: (versionResult.stderr || versionResult.stdout).slice(0, 500) });
  }

  const tagResult = spawnSync("npm", ["view", plan.preview.mirrorPackageName, `dist-tags.${plan.preview.distTag}`, "--registry", registry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (tagResult.status === 0 && tagResult.stdout.trim() === plan.preview.version) {
    addCheck("preview-dist-tag", "pass", { package: plan.preview.mirrorPackageName, distTag: plan.preview.distTag, version: plan.preview.version });
  } else {
    addCheck("preview-dist-tag", "fail", { package: plan.preview.mirrorPackageName, distTag: plan.preview.distTag, output: (tagResult.stderr || tagResult.stdout).slice(0, 500) });
  }
}

function normalizeNamespace(namespace) {
  if (typeof namespace !== "string") return "";
  return namespace.trim().replace(/^@/u, "").toLowerCase();
}

function packageLeaf(name) {
  return name.startsWith("@") ? name.split("/")[1] : name;
}

function numberOption(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

async function readChangelogReleaseNotes(cwd) {
  const changelog = await readFile(join(cwd, "CHANGELOG.md"), "utf8");
  const allHeadingPattern = /^##[ \t]+(.+?)[ \t]*$/gm;
  const headingPattern = /^##[ \t]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]+-[ \t]+(.+?)[ \t]*$/gm;
  const allHeadings = [...changelog.matchAll(allHeadingPattern)];
  const headings = [...changelog.matchAll(headingPattern)];
  const notes = new Map();
  for (const heading of headings) {
    const version = heading[1];
    const date = heading[2].trim();
    const start = heading.index + heading[0].length;
    const nextHeading = allHeadings.find((candidate) => candidate.index > heading.index);
    const end = nextHeading?.index ?? changelog.length;
    const body = changelog.slice(start, end).trim();
    if (!body) continue;
    const tagName = `v${version}`;
    notes.set(tagName, {
      tagName,
      version,
      date,
      body,
      releaseBody: [
        `Release notes from \`CHANGELOG.md\` for ${version} (${date}).`,
        "",
        body,
        "",
        "---",
        `Source: \`CHANGELOG.md\` in tag \`v${version}\`.`,
        ""
      ].join("\n")
    });
  }
  return notes;
}

async function verifyNpm(context, addCheck) {
  const spec = `${context.manifest.name}@${context.manifest.version}`;
  const result = spawnSync("npm", ["view", spec, "version", "--registry", "https://registry.npmjs.org"], {
    cwd: context.packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0 && result.stdout.trim() === context.manifest.version) {
    addCheck("npm", "pass", { spec });
    return;
  }
  addCheck("npm", "fail", { spec, output: (result.stderr || result.stdout).slice(0, 500) });
}

function verifyGitHubRelease(context, repository, addCheck) {
  const repo = repository ?? packageRepositoryName(context.manifest) ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    addCheck("github-release", "skip", { reason: "No repository configured." });
    return;
  }
  const tagName = `v${context.manifest.version}`;
  const result = spawnSync("gh", ["release", "view", tagName, "--repo", repo], {
    cwd: context.packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) {
    addCheck("github-release", "pass", { repo, tagName });
    return;
  }
  addCheck("github-release", "fail", { repo, tagName, output: (result.stderr || result.stdout).slice(0, 500) });
}

function createGitHubReleaseClient({ cwd, repository }) {
  const releaseIds = new Map();
  return {
    async listReleases() {
      const list = runGh(cwd, [
        "api",
        `repos/${repository}/releases?per_page=100`,
        "--paginate",
        "--jq",
        ".[] | {id: .id, tagName: .tag_name, body: (.body // \"\")}"
      ]);
      const rows = parseJsonLines(list.stdout);
      for (const release of rows) {
        releaseIds.set(release.tagName, release.id);
      }
      return rows;
    },
    async updateReleaseBody(tagName, body) {
      const releaseId = releaseIds.get(tagName) ?? releaseIdForTag(cwd, repository, tagName);
      const dir = await mkdtemp(join(tmpdir(), "async-release-notes-"));
      try {
        const inputPath = join(dir, "release.json");
        await writeFile(inputPath, `${JSON.stringify({ body })}\n`, "utf8");
        runGh(cwd, ["api", "--method", "PATCH", `repos/${repository}/releases/${releaseId}`, "--input", inputPath]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

function releaseIdForTag(cwd, repository, tagName) {
  const view = runGh(cwd, ["api", `repos/${repository}/releases/tags/${tagName}`, "--jq", "{id: .id}"]);
  return JSON.parse(view.stdout).id;
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function runGh(cwd, args) {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
  return result;
}

function isSemverTag(tagName) {
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName);
}

function renderBundleTable(rows) {
  return [
    "| File | Raw | Gzip | Brotli |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map((row) => `| \`${row.file}\` | ${row.raw} | ${row.gzip} | ${row.brotli} |`)
  ];
}

function packageRepositoryName(manifest) {
  const repository = manifest.repository;
  const url = typeof repository === "string"
    ? repository
    : typeof repository === "object" && repository !== null && typeof repository.url === "string"
      ? repository.url
      : undefined;
  const match = url?.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function displayBytes(value) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function loadPackageReport(cwd, evidenceDir = DEFAULT_EVIDENCE_DIR) {
  return JSON.parse(await readFile(resolveInside(cwd, join(evidenceDir, "package-report.json")), "utf8"));
}

async function loadPackagePlan(cwd, evidenceDir = DEFAULT_EVIDENCE_DIR) {
  return JSON.parse(await readFile(resolveInside(cwd, join(evidenceDir, "package-plan.json")), "utf8"));
}

async function readTextIfExists(path) {
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

async function writeEvidence(cwd, evidenceDir = DEFAULT_EVIDENCE_DIR, name, data) {
  const target = evidencePath(cwd, evidenceDir, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeEvidenceText(cwd, evidenceDir = DEFAULT_EVIDENCE_DIR, name, text) {
  const target = evidencePath(cwd, evidenceDir, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

function evidencePath(cwd, evidenceDir = DEFAULT_EVIDENCE_DIR, name) {
  return resolveInside(cwd, join(evidenceDir, name));
}

function resolveInside(cwd, inputPath) {
  const base = resolve(cwd);
  const target = resolve(base, inputPath);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`Path must stay inside ${base}: ${inputPath}`);
  }
  return target;
}

function relativePath(cwd, target) {
  return relative(cwd, target) || ".";
}
