# Changelog

## 0.1.6 - 2026-07-06

### Fixed

- Verify preview dist-tags by resolving `<package>@<dist-tag>` to its version,
  avoiding nested dist-tag field reads that can fail against GitHub Packages.

## 0.1.5 - 2026-06-19

### Fixed

- Prefer `GITHUB_TOKEN` over ambient `NODE_AUTH_TOKEN` for preview doctor
  GitHub Packages reads.

## 0.1.4 - 2026-06-19

### Fixed

- Let preview doctor perform authenticated, read-only GitHub Packages checks
  with the workflow token and retry registry reads after preview publish.

## 0.1.3 - 2026-06-19

### Added

- Add `async-release preview plan|stage|inspect|doctor` commands for
  deterministic preview package identity, staging, install-comment, inspection,
  and read-only doctor evidence.

## 0.1.2 - 2026-06-19

### Fixed

- Switch release-description sync to GitHub's REST releases API for listing
  and updating release bodies, avoiding `gh release list` GraphQL timeouts.

## 0.1.1 - 2026-06-19

### Added

- Add `async-release release sync-descriptions --package <path> [--check]` so
  generated lifecycle callers can check or repair semver GitHub Release
  descriptions from `CHANGELOG.md` without publishing packages.

## 0.1.0 - 2026-06-19

### Added

- Add the initial `async-release` CLI with package planning, package inspection,
  changelog checks, release-note rendering, and doctor evidence commands.
