# Changelog

## Unreleased

### Added
- Bounded lifetime client counters: exact through 1,024 clients, then 4,096-byte HyperLogLog sketches; statistics expose approximation flags.
- Statistics detail limits of 2,048 request geohash cells per amenity and 256 individually tracked amenities, with count-preserving geographic compaction and an overflow amenity row.
- Regression coverage for client sketch persistence, bounded Redis batches, compact presence metadata, enqueue coalescing, active cancellation, shutdown, and response clone isolation.
- Memory architecture, migration, benchmark limitations, and remaining optimization opportunities in `docs/MEMORY_OPTIMIZATIONS.md`.
- Bounded upstream-availability waiting for cache-miss interpreter requests when all upstreams are temporarily in backoff.
- Recovery fetch replanning with smaller bbox groups to reduce refill pressure on the first upstream that becomes available again.
- Integration coverage for immediate stale-cache responses during temporary upstream exhaustion.
- Persisted upstream `backoffReason` metadata for logs, statistics snapshots, and post-restart debugging.

### Changed
- Removed the statistics worker's duplicate full tile presence index. Worker statistics retain Redis-derived aggregates; inline statistics share the request handler's store.
- Packed normal presence entries into exact numeric metadata, with overflow counts and fallback representations for exceptional expiry timestamps.
- Limited tile and metadata MGET reads/decoding to 500 values per batch, including oversized SCAN results, without changing the query interface.
- Response assembly now resolves duplicate precedence before cloning surviving elements, preserving output order and runtime Overpass fields.
- Compatible pending refreshes now coalesce on enqueue by amenity, fetch-plan options, and explicit executor identity; each combined workload runs once.
- Inline stale-request statistics now count requests on enqueue, matching worker behavior without retaining per-request completion closures.
- Transparent proxy requests keep fail-fast upstream behavior instead of entering the availability-wait loop.
- Integration test defaults now use short backoff/probe windows so shared test servers do not stay blocked behind stale upstream state.
- Statistics map upstream cards now display the stored backoff cause as a dedicated field.
- Documentation now calls out that fully stale-covered requests can still return `200` while the upstream pool is empty, whereas unresolved coverage returns `503`.
- Statistics snapshot rebuilds are time-sliced; worker cache metadata scans reuse aggregates while cache revision and refresh age allow.
- Cache inventory counters use aggregates so top-level statistics do not traverse the full in-memory tile index.

### Fixed
- Background refresh timeouts now abort upstream requests and availability waits and prevent subsequent fetches and cache writes; cancellation does not penalize upstream health.
- Inline shutdown now aborts active refresh work and discards pending refreshes while settling completion callbacks.
- Cacheable tile fetches now send canonical `"[out:json][timeout:120];"` queries and explicitly request JSON from upstreams.
- Cacheable and transparent `out:json` interpreter requests now accept valid Overpass XML upstream responses and normalize them back to JSON for clients, while XML `<remark>`/error payloads still trigger failover and backoff.
- Upstream tile fetching now treats XML/HTML/text error bodies as upstream failures with clearer diagnostics, allowing failover to the next configured upstream instead of surfacing only a raw JSON parse error.
- Statistics snapshot refreshes no longer time out on near-global cache datasets just to compute top-level cache totals or stale tile counts.

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
