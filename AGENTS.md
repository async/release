# Agent Instructions

This repo owns `@async/release`, the deterministic release-planning and doctor
CLI used by generated Async release workflows.

## Rules

- Keep the package dependency-light and Node.js ESM. Source files are `.js`
  under `src/`.
- Do not read, print, copy, upload, or summarize secrets. Doctor commands may
  check for required token presence, but they must not echo token values.
- Release planning and local inspection must be deterministic by default.
  Network checks belong to doctor mode and must be mockable with
  `--network mock`.
- `async/actions` may wrap this CLI, but workflow permissions, environments,
  package selection policy, and job ordering stay with `@async/pipeline`.
- Run `pnpm run release:check` before handoff.
