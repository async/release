# @async/release

Release planning, package inspection, release-note rendering, and doctor
evidence for Async packages.

`@async/pipeline` owns the generated job graph, permissions, environments, and
package selection policy. `@async/release` owns package-aware release evidence:
what package is being released, what profile it matches, what the changelog
says, what files npm will publish, and whether the published state matches the
release.

## Commands

```sh
async-release package plan --package . --json --evidence-dir .async/release
async-release package inspect --package . --json --evidence-dir .async/release
async-release preview plan --package . --mode pr --namespace async --pr-number 12 --head-sha <sha> --source-sha <sha> --json --evidence-dir .async/release
async-release preview stage --package . --mode pr --namespace async --registry https://npm.pkg.github.com --pr-number 12 --head-sha <sha> --source-sha <sha> --json --evidence-dir .async/release
async-release preview inspect --package . --mode main --namespace async --source-sha <sha> --json --evidence-dir .async/release
async-release preview doctor --package . --mode pr --namespace async --network mock --pr-number 12 --head-sha <sha> --source-sha <sha> --json --evidence-dir .async/release
async-release changelog check --package . --json --evidence-dir .async/release
async-release notes render --package . --json --evidence-dir .async/release
async-release release sync-descriptions --package . --check --json --evidence-dir .async/release
async-release doctor --package . --network mock --json --evidence-dir .async/release
```

The authoritative release doctor can run with `--network live` in GitHub
Actions. Local harnesses should use `--network mock` until the generated job is
executing inside its real release environment.

`release sync-descriptions` treats `CHANGELOG.md` as the source of truth for
semver GitHub Release bodies. `--check` reports drift without patching releases;
without `--check`, drifted semver release descriptions are updated and
non-semver releases are ignored.

`preview plan` computes the mirror package name, immutable preview version,
dist-tag, install target, and bounded PR comment body from explicit caller
inputs. `preview stage` writes a credential-free staging package manifest and
pack file layout for the privileged action to publish. `preview inspect` reuses
package inspection evidence for preview artifacts. `preview doctor` is read-only:
use `--network mock` for deterministic local evidence and `--network live` in
the publishing workflow to verify the immutable version and mutable dist-tag.

## Package Profiles

Inspection classifies packages as:

- `node-library`
- `cli`
- `browser-bundle`
- `framework-browser`
- `contract-schema`
- `workspace-root`

The `framework-browser` profile emits bundle size evidence for browser-facing
files and diff links derived from the package repository metadata.

## Verification

```sh
pnpm run release:check
```
