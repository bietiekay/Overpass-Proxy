# Changelog

## 1.5.0 - 2026-03-06

### Added
- Statistics refresh impact performance gate via `npm run test:perf:statistics` to enforce interpreter-latency protection during statistics rebuild pressure.
- Integration coverage for stale statistics snapshot self-healing behavior.
- Unit coverage for transient statistics build failures with retry recovery.

### Changed
- `/api/statistics` now triggers asynchronous rebuilds when snapshots are pending/stale in worker mode.
- Statistics refresh in worker/inline paths now marks snapshots dirty before rebuilding, ensuring refresh requests produce new snapshots.
- Refresh trigger throttling was added per statistics target to avoid refresh storms under repeated pending reads.
- Statistics snapshot logging now includes richer context (`target`, `durationMs`, `ageMs`, `failureCount`) for troubleshooting.
- Version bumped to `1.5.0`.

### Fixed
- Removed stale lint issues across logger, store, and test files (unused variables/imports, NodeJS namespace types, unused eslint directives).
