# PROJECT MAP & EVIDENCE INDEX

## 1) Repository Inventory

### High-level tree overview
- `specification.md` — authoritative architecture + workflow narrative for the proxy service.
- `README.md` — operational overview, configuration, endpoints, and tooling notes.
- `package.json` — runtime + dev dependencies and scripts.
- `src/` — TypeScript source for the Fastify proxy, caching, upstream routing, statistics, and utilities.
- `src/tests/` — Vitest unit + integration tests and helper utilities.
- `public/` — static operator dashboards (statistics map, cache preheater, cache invalidator).
- `.specstory/history/` — decision history and troubleshooting logs.
- `Dockerfile`, `docker-compose.yml.template` — containerization assets.
- `docs/` — documentation (this file).

### Major modules, packages, services, scripts
- **Service entrypoint + server wiring**: `src/index.ts` (Fastify server, CORS, HTML assets, Redis init, stats worker init).
- **Request routing + cacheable workflow**: `src/interpreter.ts` (interpreter validation, cache lookup, cache invalidation, statistics endpoints, transparent proxying).
- **Caching layer**: `src/store.ts` (Redis-backed tile storage, SWR locks, cache coverage).
- **Upstream integration**: `src/upstream.ts` (Overpass query construction, upstream pool with cooldowns/backoff/daily limits, transparent proxy).
- **Query parsing + tiling**: `src/bbox.ts`, `src/tiling.ts`, `src/fetchPlan.ts` (bbox extraction, geohash tiling, fetch grouping).
- **Response assembly + headers**: `src/assemble.ts`, `src/headers.ts` (dedupe, bbox filtering, ETag/304 handling).
- **Statistics + background worker**: `src/stats.ts`, `src/statsWorker.ts`, `src/staleRefreshQueue.ts`, `src/time.ts`.
- **Utilities**: `src/config.ts`, `src/logger.ts`, `src/rateLimit.ts`, `src/errors.ts`.
- **Tests**: `src/tests/unit/*.test.ts`, `src/tests/integration/*.test.ts`, `src/tests/integration/mock-overpass.ts`, `src/tests/helpers/inMemoryRedis.ts`.
- **Scripts** (from `package.json`): build/test/dev/lint/test:ci and docker-enabled tests.

## 2) Evidence Index

| Topic / Concept | Primary Evidence (file paths + short identifiers) | Secondary Evidence | Notes / Conflicts / Open Questions |
| --- | --- | --- | --- |
| Core domain concepts (Overpass proxy, amenity-focused caching) | `specification.md` (Purpose, Architectural Overview, Tile Caching Pipeline); `src/interpreter.ts` (`handleCacheable`, `/api/interpreter` handling); `src/store.ts` (`TileStore` cache model) | `README.md` (Summary/Features/Endpoints); `src/tests/integration/integration.test.ts` (amenity cache separation) | Amenity-only cacheability is enforced by query parsing, otherwise transparent proxy. |
| Main workflows (request lifecycle) | `specification.md` (Request Classification Flow, Mermaid diagram); `src/interpreter.ts` (`registerInterpreterRoutes`, `handleCacheable`) | `src/tests/integration/integration.test.ts` (cache hit/miss/stale flows, ETag handling) | Flow includes SWR behavior and 503 on unresolved tiles. |
| Edge cases & failure modes | `src/interpreter.ts` (400 for missing query/bbox, 413 TooManyTiles, 503 on unresolved tiles); `src/store.ts` (refresh locks, miss locks) | `src/tests/unit/store.test.ts` (lock edge cases), `src/tests/unit/tiling.test.ts` (invalid bbox) | Error responses are structured with JSON `{ error }` in interpreter paths. |
| Configuration & environment assumptions | `src/config.ts` (`loadConfig` defaults and env parsing) | `README.md` (Configuration table), `package.json` (Node >=20) | Defaults are tuned for ToiletFinder map viewport; explicit ENV keys documented in README. |
| External dependencies / integrations | `src/index.ts` (Fastify, ioredis), `src/upstream.ts` (got for HTTP), `src/tiling.ts` (ngeohash), `src/logger.ts` (pino) | `package.json` (dependency list), `src/tests/integration/testcontainers.ts` (testcontainers + docker) | Upstream Overpass API is a required external integration; Redis is required for caching. |
| Security or privacy assumptions | `src/interpreter.ts` (`/api/cache/invalidate` secret handling), `src/index.ts` (CORS `*` policy) | `README.md` (cache invalidation secret flow), `.specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md` | CORS is permissive (`*`); invalidation requires shared secret; client IP is logged by default. |
| Performance constraints | `src/interpreter.ts` (tile limit enforcement), `src/config.ts` (`MAX_TILES_PER_REQUEST`), `src/fetchPlan.ts` (tile grouping) | `specification.md` (tile budget rationale), `README.md` (tile precision guidance) | Performance hinges on tile count and upstream grouping; stale refresh queue avoids synchronous waits. |
| “Why we did this” decision traces | `.specstory/history/*.md` (decision logs), `specification.md` (Tile caching rationale) | `README.md` (tooling rationale + operator dashboards) | Specstory provides chronological rationale for changes and troubleshooting. |
| Statistics + observability | `src/stats.ts` (`RequestStatistics`, snapshots), `src/statsWorker.ts` (worker persistence) | `README.md` (Statistics endpoints), `public/statistics-map.html` (operator dashboard) | Stats snapshots exclude cache coverage payload unless requested. |
| Cache invalidation workflow | `src/interpreter.ts` (`/api/cache/invalidate`), `src/store.ts` (`invalidateTiles`) | `README.md` (cache invalidation API), `public/cache-invalidator.html` | Requires `CACHE_INVALIDATION_SECRET`. |
| Transparent proxy behavior | `src/interpreter.ts` (`proxyTransparent` for non-cacheable or transparentOnly) | `specification.md` (Transparent Proxy Behaviour) | Non-cacheable requests are proxied to maintain Overpass API compatibility. |

## 3) Specstory Signal Extraction

### Top 20 decision moments (file + summary)
1. `.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md` — Bind proxy/redis/overpass ports to localhost; remap proxy to `127.0.0.1:5002:8080`.
2. `.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md` — Remove mock overpass service from docker-compose; set `UPSTREAM_URL` to external Overpass instance.
3. `.specstory/history/2025-10-28_12-26Z-fix-typescript-module-configuration-error.md` — Update `tsconfig.json` `module` to `Node16` to resolve TS5110.
4. `.specstory/history/2025-10-28_12-36Z-npm-audit-and-test-results.md` — Run `npm audit fix --force`, observe major upgrades (pino/vitest) and test failures.
5. `.specstory/history/2025-10-28_12-40Z-npm-warnings-and-deprecated-packages.md` — Document npm deprecation warnings and suggest dependency updates.
6. `.specstory/history/2025-10-28_12-53Z-troubleshooting-overpass-api-400-error.md` — Investigate 400 errors for specific Overpass query payloads.
7. `.specstory/history/2025-10-28_13-07Z-add-logging-for-request-handling-flow.md` — Add logging for bbox details and Redis tile read/write flow.
8. `.specstory/history/2025-10-28_13-19Z-add-more-logging-for-requests.md` — Add logging for incoming requests and POST bodies.
9. `.specstory/history/2025-10-28_13-35Z-valid-post-body-query-examples.md` — Provide valid POST body query examples for `/api/interpreter`.
10. `.specstory/history/2025-10-28_13-42Z-redis-connection-refused-errors.md` — Diagnose Redis connectivity failures in proxy logs.
11. `.specstory/history/2025-10-28_13-46Z-proxy-server-request-handling-logs.md` — Review runtime logs showing request/response flow and tile list output.
12. `.specstory/history/2025-10-28_13-54Z-excessive-requests-to-upstream-overpass.md` — Investigate excessive upstream requests due to overlapping tile fetches.
13. `.specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md` — Add CORS headers to allow browser access from overpass-turbo.
14. `.specstory/history/2025-10-28_15-40Z-proxy-returns-incorrect-amenity-data.md` — Debug incorrect amenity filter application in proxy results.
15. `.specstory/history/2025-12-05_09-57Z-optimize-overpass-proxy-upstream-handling.md` — Analyze upstream distribution, monitoring, failure handling, cooldowns, and quota enforcement.
16. `.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md` — Plan weighted upstream routing, probes, persistence, and test coverage enhancements.
17. `.specstory/history/2025-12-05_13-34Z-log-upstream-errors-at-errors-level.md` — Ensure upstream errors are logged at error level.
18. `.specstory/history/2025-12-05_14-08Z-overpass-proxy-post-request-for-api.md` — Prefer POST for `/api/interpreter` to improve reliability.
19. `.specstory/history/2025-12-05_14-24Z-add-missing-fields-to-proxied-post-request.md` — Add missing headers/fields to proxied POST request to match working curl example.
20. `.specstory/history/2025-12-16_10-26Z-cache-preheater-task-queueing-issue.md` — Investigate cache-preheater queue stalling and plan fix.

### Reversals or pivots (X → Y) with pointers
- Expose proxy ports publicly → Bind ports to localhost-only with a remapped external port (`.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md`).
- Use internal mock Overpass service → Point to external Overpass endpoint and drop mock service from compose (`.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md`).
- Rely on GET for `/api/interpreter` compatibility → Prefer POST for reliability (`.specstory/history/2025-12-05_14-08Z-overpass-proxy-post-request-for-api.md`).
- Random upstream selection only → Plan weighted EWMA + probes + persistence (`.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md`).
- Missing CORS headers → Add permissive CORS behavior for browser clients (`.specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md`).

## 4) Glossary Seed

| Term | Short definition | Evidence pointers |
| --- | --- | --- |
| Overpass Proxy | Fastify-based service mirroring Overpass API with amenity-focused caching. | `specification.md` (Purpose), `src/index.ts` (server bootstrap) |
| Amenity | Overpass tag filter used to segment cache and queries. | `src/bbox.ts` (`extractAmenityValue`), `src/interpreter.ts` (`extractAmenityPreference`) |
| Bounding box (bbox) | South/west/north/east coordinates used to scope cacheable queries. | `src/bbox.ts` (`extractBoundingBox`), `src/interpreter.ts` (bbox validation) |
| Geohash tile | Spatial tile ID derived from bbox; key for caching. | `src/tiling.ts` (`tilesForBoundingBox`, `tileKey`) |
| Tile cache | Redis-stored JSON payload per amenity+geohash tile. | `src/store.ts` (`TileStore`, key format), `specification.md` (Redis data model) |
| Stale-while-revalidate (SWR) | Serve stale cached tiles while refreshing in background. | `specification.md` (Tile Caching Pipeline), `src/store.ts` (refresh locks), `src/interpreter.ts` (stale handling) |
| Cache coverage | Aggregate view of which tiles are cached and their freshness. | `src/store.ts` (`getCacheCoverageForBounds`), `src/stats.ts` (cache coverage snapshots) |
| Stale refresh queue | Background queue that refreshes stale tiles asynchronously. | `src/staleRefreshQueue.ts`, `src/statsWorker.ts` (enqueue) |
| Upstream pool | Logic for selecting Overpass upstreams with cooldowns/backoff and quotas. | `src/upstream.ts` (`UpstreamPool`, `withUpstream`) |
| Cache invalidation | Endpoint to delete cached tiles within a bbox (secret-protected). | `src/interpreter.ts` (`/api/cache/invalidate`), `README.md` (API behavior) |
| Transparent proxy | Pass-through handling for non-cacheable endpoints/requests. | `src/interpreter.ts` (`proxyTransparent`), `specification.md` (Transparent Proxy Behaviour) |
| ETag conditional response | Weak ETag generation and 304 handling for cached responses. | `src/headers.ts` (`generateEtag`, `applyConditionalHeaders`), `src/tests/unit/headers.test.ts` |
| Statistics snapshot | Aggregated metrics for cache hits, requests, hotspots, and upstreams. | `src/stats.ts` (`RequestStatistics`, snapshots), `README.md` (statistics endpoints) |
