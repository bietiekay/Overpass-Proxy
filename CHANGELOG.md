# Changelog

## Unreleased

### Added
- Bounded upstream-availability waiting for cache-miss interpreter requests when all upstreams are temporarily in backoff.
- Recovery fetch replanning with smaller bbox groups to reduce refill pressure on the first upstream that becomes available again.
- Integration coverage for immediate stale-cache responses during temporary upstream exhaustion.
- Persisted upstream `backoffReason` metadata for logs, statistics snapshots, and post-restart debugging.

### Changed
- Transparent proxy requests keep fail-fast upstream behavior instead of entering the availability-wait loop.
- Integration test defaults now use short backoff/probe windows so shared test servers do not stay blocked behind stale upstream state.
- Statistics map upstream cards now display the stored backoff cause as a dedicated field.
- Documentation now calls out that fully stale-covered requests can still return `200` while the upstream pool is empty, whereas unresolved coverage returns `503`.

### Fixed
- Cacheable tile fetches now send canonical `"[out:json][timeout:120];"` queries and explicitly request JSON from upstreams.
- Upstream tile fetching now treats XML/HTML/text error bodies as upstream failures with clearer diagnostics, allowing failover to the next configured upstream instead of surfacing only a raw JSON parse error.

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
