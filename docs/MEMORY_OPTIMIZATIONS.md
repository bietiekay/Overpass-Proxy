# Memory optimizations

This document describes the memory changes implemented on 2026-10-25. Query syntax,
HTTP routes, tile cache keys and assembled response semantics remain compatible.
Statistics detail and client-count accuracy have explicit limits below.

## Cache and response memory

- The request handler owns the only full tile presence index. Inline statistics reuse
  that store. The statistics worker scans Redis metadata in batches and retains
  per-amenity counters and compacted coverage rather than another per-tile index.
- Normal presence entries encode millisecond expiry, stale state and item count in a
  safe integer. Counts above 1,023 use an overflow map. Unrepresentable timestamps
  retain an exact fallback representation, including fractional and extreme expiries.
- Every tile or metadata MGET fetches at most 500 values. SCAN COUNT is a hint, so
  oversized SCAN pages are also split before fetching and decoding values.
- Response assembly filters each input response, resolves duplicates by `(type,id)`,
  then clones only surviving elements. The last eligible value wins; first insertion
  order, metadata and the existing clone isolation for tags/nodes/members survive.
- Read batching bounds temporary raw payload batches, not the complete parsed
  response. All parsed tiles and the final assembled result can still coexist.

Tile payloads remain in Redis until overwritten or invalidated. `expiresAt` controls
logical staleness; shortening CACHE_TTL_SECONDS does not evict payloads or the full
presence inventory. The full index still grows with the number of cached tiles.

## Statistics limits and migration

| Detail | Default behavior |
| --- | --- |
| Unique clients, globally and per amenity | Exact through 1,024; then a 4,096-byte HyperLogLog sketch, approximately 1.6% standard relative error |
| Request geohashes per amenity | At most 2,048 cells; precision decreases and counts merge as needed |
| Individually tracked request amenities | At most 256, plus one `[other amenities]` overflow row |
| Worker cache coverage | Compacted aggregate map, default target 25,000 entries |

Request totals, cache status counters and requested tile totals remain exact.
`clientCountsApproximate` marks estimated global client counts;
`clientCountApproximate` marks them per amenity. `groupedAmenities` identifies the
presence of the overflow row. Coarser request geohashes affect map/hotspot detail.
These limits do not change upstream amenity queries or cache segmentation.

Existing statistics arrays migrate when loaded. The next recorded request persists
bounded client sketches and detail maps under `statistics:current`. Older versions
cannot interpret sketches: keep this version or newer when reusing the migrated
statistics state. The tile payload format does not require migration.

Concurrent worker metadata refreshes share one scan. Changed-cache scans have a
30-second minimum interval; unchanged revisions can reuse aggregates for five minutes.
This is scan throttling, not a maximum age guarantee for HTTP snapshots: normal
snapshot scheduling defaults to five minutes, and failed refreshes can delay updates.

## Refresh lifetime and queueing

Pending jobs coalesce when amenity, plan options and explicit executor identity match.
One executor receives the combined unique tile set. Tasks without an explicit
coalescing identity keep independent callback semantics. Active work is not merged
with later requests. Queue metrics count pending jobs after coalescing.

Timeouts abort active upstream HTTP requests and availability waits. Refresh loops
check the signal before another group fetch and before writing fetched results.
Cancellation does not mark an upstream unhealthy or trigger its failure backoff.
A Redis command already sent cannot be rolled back by an AbortSignal.

Inline shutdown discards pending refresh jobs, settles their callbacks, aborts active
work and awaits queue draining. Worker shutdown terminates its worker thread.
Request statistics are recorded once on enqueue in both modes, independently of
refresh completion, avoiding retained per-request completion closures in production.

## Validation and measurements

`npm run verify` runs lint, TypeScript compilation and the unit/integration suite.
The implementation passed 246 tests across 17 files. Coverage includes mixed
hit/missing/corrupt reads across more than 500 tiles, SCAN over-return, numeric
metadata boundaries, sketch restart migration, duplicate precedence and cloning,
compatible/incompatible queue tasks, availability cancellation and shutdown.

Manual checks used isolated local Redis and HTTP servers; no public upstream was
required. The local runtime for these checks was Node.js 22.23.4; Node.js 26 remains
the supported deployment runtime and requires its normal CI/release validation.

| Synthetic check | Before | After | Interpretation |
| --- | --- | --- | --- |
| Full presence index, 100,000 tiles | 12.80 MiB | 7.48 MiB | About 42% less retained heap plus ArrayBuffer storage |
| Restore same presence inventory | About 166 ms | About 180–187 ms | Some startup overhead; timings vary |
| Real Redis, 1,101 tile payloads, warmed p95 | 3.18 ms | 4.34 ms | Additional round trips trade latency for bounded raw batches |
| Statistics refresh latency gate | Baseline 0.74 ms p95 | Stressed 0.75 ms p95 | Mock/in-memory harness, not a production throughput claim |

These are fixture-specific observations, not whole-process memory savings or
production latency guarantees. Benchmark harnesses for the manual checks were
session-local; the retained automated performance command is
`LOG_LEVEL=silent npm run test:perf:statistics`.

## Remaining opportunities (not implemented)

- Bound Redis write pipeline sizes and generate/write fine-tile responses in chunks.
- Merge tile responses incrementally so redundant parsed inputs can be released sooner.
- Batch worker messages and add acknowledgements/backpressure for real queue depth.
- Persist statistics deltas instead of serializing the full state per request.
- Stream suitable transparent responses, accounting for normalization and retries.
- Apply overall concurrency/queue budgets for workloads with many distinct tiles.

Coalescing does not impose a hard queue-size limit, and read batching does not impose
a total per-request memory budget. Profile realistic response sizes and parallel
clients before selecting the next optimization.
