# INTENT & PROBLEM RECONSTRUCTION

## 1. One-Sentence Purpose (Final Form)
Provide a Fastify-based Overpass API proxy that preserves upstream compatibility while accelerating amenity-focused JSON bbox queries via Redis-backed geohash tile caching and operational telemetry.【specification.md, README.md, src/index.ts, src/interpreter.ts】

## 2. Problem Statements

### Primary problem
- Clients (notably ToiletFinder) need Overpass amenity queries to respond faster and more reliably for map viewports, without changing their API usage, by caching bbox-tiled JSON results behind an Overpass-compatible proxy.【specification.md, README.md, src/interpreter.ts, src/store.ts】

### Secondary problems
- Protect upstream Overpass availability with caching, stale-while-revalidate, and quota-aware upstream routing to reduce load and avoid outages.【specification.md, README.md, src/store.ts, src/upstream.ts】
- Provide observable statistics about cache coverage, hotspots, and request demand for operators and dashboards.【specification.md, README.md, src/stats.ts, public/statistics-map.html】
- Maintain compatibility for non-cacheable Overpass endpoints by transparently proxying all `/api/*` requests that are not amenity JSON bbox queries.【specification.md, src/interpreter.ts】

### Explicit non-goals
- The proxy does not aim to cache arbitrary Overpass query types (non-amenity or non-JSON queries are passed through).【specification.md, src/interpreter.ts】
- The system does not guarantee partial responses for missing tiles; unresolved cache misses return 503 instead of partial data.【specification.md, src/interpreter.ts】
- The token-bucket rate limiter is present but not active in request flow (utility only, not enforced).【specification.md, src/rateLimit.ts】

## 3. Target Users & Stakeholders
- **Client application developers** (e.g., ToiletFinder) who need an Overpass-compatible endpoint with faster amenity queries and stable behavior across GET/POST requests.【specification.md, README.md, src/interpreter.ts】
- **Operators/SREs** managing cache coverage, invalidation, and upstream quotas via dashboards and statistics endpoints.【specification.md, README.md, public/statistics-map.html, public/cache-preheater.html, public/cache-invalidator.html】
- **Integration/test engineers** using embedded mock Overpass and in-memory Redis for deterministic test runs.【src/tests/integration/mock-overpass.ts, src/tests/helpers/inMemoryRedis.ts, src/tests/integration/testcontainers.ts】
- **Upstream Overpass providers** affected by request volume, cooldown behavior, and daily request limits enforced by the proxy.【specification.md, README.md, src/upstream.ts】

## 4. Operating Context & Assumptions

### Runtime/deployment assumptions
- Node.js 20+ runtime with Fastify; service listens on `0.0.0.0:PORT` and expects Redis connectivity via `REDIS_URL`.【package.json, src/index.ts, src/config.ts】
- Supports standalone runs and Docker deployments; stats worker uses a Redis connection and background threads for persistence and coverage caching.【specification.md, src/index.ts, src/statsWorker.ts】
- CORS headers are permissive to allow browser-based clients (notably overpass-turbo) to call the proxy directly.【src/index.ts, .specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md】

### Data assumptions
- Cacheable queries must be Overpass QL with `out:json` and an `amenity` filter, and must include a bounding box. Non-conforming queries are proxied upstream instead of cached.【specification.md, src/interpreter.ts, src/bbox.ts】
- Cached tile entries are keyed by `tile:<amenity>:<geohash>` with metadata (`response`, `fetchedAt`, `expiresAt`) and can be served stale within SWR window.【specification.md, src/store.ts】
- Tile expansion uses geohash precision defaulting to 5, and requests exceeding `MAX_TILES_PER_REQUEST` are rejected to prevent unbounded workload.【specification.md, src/config.ts, src/interpreter.ts】

### Human workflow assumptions
- Operators rely on `/api/statistics` and dashboard HTML pages to monitor cache health and hotspots, and on cache invalidation tooling to remove stale data when needed.【specification.md, README.md, public/statistics-map.html, public/cache-invalidator.html】
- Integration tests may run with or without Docker; when Docker is unavailable, in-memory Redis and an embedded mock Overpass server are used.【README.md, src/tests/integration/testcontainers.ts, src/tests/helpers/inMemoryRedis.ts】

## 5. Design Drivers (Ranked)

1. **Behavioral compatibility with Overpass API**
   - **Description:** Preserve API surface for `/api/*` endpoints while adding caching for amenity JSON bbox queries.
   - **Why it mattered:** Clients should switch endpoints without behavior changes; non-cacheable requests must still work.
   - **Evidence pointers:** `specification.md` (Purpose, Transparent Proxy Behaviour), `README.md` (Endpoints), `src/interpreter.ts` (transparent proxy logic).

2. **Performance via tile caching and SWR**
   - **Description:** Use geohash tiles and stale-while-revalidate to serve cached responses quickly while refreshing in background.
   - **Why it mattered:** Amenity map queries are latency-sensitive and repetitive; SWR reduces perceived latency.
   - **Evidence pointers:** `specification.md` (Tile Caching Pipeline), `src/store.ts` (locks, TTL/SWR), `src/interpreter.ts` (stale handling).

3. **Controlled upstream load and resilience**
   - **Description:** Implement tile budget caps, grouped upstream fetches, and upstream pool cooldowns/limits.
   - **Why it mattered:** Avoid overwhelming upstream Overpass servers and ensure availability under demand spikes.
   - **Evidence pointers:** `specification.md` (Tile budget, Upstream Daily Limits), `src/interpreter.ts` (TooManyTiles), `src/fetchPlan.ts` (grouping), `src/upstream.ts` (cooldown/quota).

4. **Operational observability**
   - **Description:** Provide statistics snapshots, cache coverage views, and operator dashboards.
   - **Why it mattered:** Operators need visibility into cache performance and demand hotspots to tune TTLs or preheat.
   - **Evidence pointers:** `specification.md` (Request Statistics), `src/stats.ts`, `public/statistics-map.html`, `README.md` (statistics endpoints).

5. **Safety for manual cache control**
   - **Description:** Require a shared secret for cache invalidation and support multiple bbox input formats.
   - **Why it mattered:** Prevent unauthorized cache flushes while giving operators a deterministic invalidation flow.
   - **Evidence pointers:** `src/interpreter.ts` (`/api/cache/invalidate`), `README.md` (cache invalidation API), `public/cache-invalidator.html`.

6. **Testability without Docker dependencies**
   - **Description:** Support in-process integration tests using in-memory Redis and a mock Overpass server.
   - **Why it mattered:** Keep CI reliable without requiring Docker while still validating cache workflows.
   - **Evidence pointers:** `README.md` (Testing), `src/tests/integration/testcontainers.ts`, `src/tests/integration/mock-overpass.ts`.

## 6. Evolution Narrative

1. **Port binding hardened to localhost-only** — Compose mapping changed to bind proxy/redis/overpass ports to localhost and remap proxy to 5002 for local access.【.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md】
2. **Mock Overpass removed from compose** — Shifted to external Overpass endpoint for deployment instead of containerized mock service.【.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md】
3. **TypeScript module configuration fix** — Adjusted `tsconfig.json` module setting to resolve build errors with Node16 module resolution.【.specstory/history/2025-10-28_12-26Z-fix-typescript-module-configuration-error.md】
4. **Dependency audit and test outcomes documented** — Recorded audit updates and test failures following forced package upgrades.【.specstory/history/2025-10-28_12-36Z-npm-audit-and-test-results.md】
5. **Logging expanded for request details** — Added incoming request and body logging to aid troubleshooting and validation flows.【.specstory/history/2025-10-28_13-19Z-add-more-logging-for-requests.md, src/index.ts】
6. **Logging for bbox + cache flow** — Instrumented bbox and Redis tile read/write logging for cacheable interpreter requests.【.specstory/history/2025-10-28_13-07Z-add-logging-for-request-handling-flow.md, src/interpreter.ts】
7. **CORS permissive policy introduced** — Added headers to allow browser-based clients like overpass-turbo to access the proxy.【.specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md, src/index.ts】
8. **POST preference for interpreter** — Diagnosed GET instability and guided POST usage for more reliable interpreter requests.【.specstory/history/2025-12-05_14-08Z-overpass-proxy-post-request-for-api.md, src/interpreter.ts】
9. **Upstream routing enhancements planned** — Planned weighted routing, probes, persistence, and error handling improvements for multiple upstreams.【.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md, src/upstream.ts】
10. **Cache preheater queue issues surfaced** — Identified stalled preheater queue behavior needing fixes in UI/workflow tools.【.specstory/history/2025-12-16_10-26Z-cache-preheater-task-queueing-issue.md, public/cache-preheater.html】

## 7. Hidden or Implicit Requirements
- **Amenity normalization is required for cache segmentation** — The code normalizes amenity values to lowercase, implying cache keys are case-insensitive and consistent across requests.【src/interpreter.ts】
- **Cache coverage snapshots must be bounded** — Coverage compaction and size limits in stats logic imply payloads must remain bounded for UI consumption.【src/stats.ts, src/store.ts】
- **Tile-level deduplication is necessary to avoid duplicate elements** — Assembly combines responses and deduplicates by `(type,id)` while filtering by bbox, implying correctness requirements for map displays.【src/assemble.ts, src/tests/unit/assemble.test.ts】
- **SWR is only safe when cache coverage is complete** — Background refresh is only deferred if cached tiles fully cover the request; otherwise responses are synchronized with upstream refresh to prevent partial data.【specification.md, src/interpreter.ts】
- **Redis availability is critical** — Cacheable path assumes Redis connectivity; Redis failures result in 500s and retry errors, implying operational dependence on Redis uptime.【.specstory/history/2025-10-28_13-42Z-redis-connection-refused-errors.md, src/index.ts】

## 8. Open Questions & Reconstruction Assumptions

### Open Questions
- **What is the canonical list of amenity types or any allowlist?** The system only validates presence of `amenity` filters, but no explicit allowlist is shown; if intended, it is not enforced in code.【src/bbox.ts, src/interpreter.ts】
- **Should stale cache ever be served when there are partial misses?** Current behavior returns 503 rather than partial data; confirm if partial stale responses are acceptable for clients.【specification.md, src/interpreter.ts】
- **Is `TRANSPARENT_ONLY` intended for emergency bypass or permanent mode?** The config toggles caching entirely, but operational policy is not documented beyond configuration defaults.【src/config.ts, README.md】

### Reconstruction Assumptions
- **Assumption: ToiletFinder-specific viewport sizing drove defaults.** The tile precision and tile count limits reference ToiletFinder viewport sizes in documentation, suggesting default values were optimized for that client’s map usage.【README.md, specification.md】
- **Assumption: Operator dashboards are integral to runtime ops.** Presence of multiple HTML tools and dedicated statistics endpoints implies these are expected to be used in daily operations rather than optional extras.【README.md, public/statistics-map.html, public/cache-preheater.html, public/cache-invalidator.html】
- **Assumption: Upstream availability varies and needs resilience tooling.** Multiple upstream URLs, cooldown logic, and SpecStory notes about improvements imply upstream instability is a real-world constraint.【specification.md, src/upstream.ts, .specstory/history/2025-12-05_09-57Z-optimize-overpass-proxy-upstream-handling.md】
