# PROJECT REQUIREMENTS DOCUMENT (PRD)

## 1. Overview

### Purpose
Provide an Overpass-compatible HTTP proxy that accelerates amenity-focused JSON bbox queries using Redis-backed geohash tile caching, while preserving transparent proxy behavior for non-cacheable requests and exposing operational statistics for operators.【specification.md, README.md, src/interpreter.ts, src/store.ts, docs/INTENT_AND_PROBLEM_RECONSTRUCTION.md】

### Scope
- Accept `/api/interpreter` GET/POST requests, validate amenity JSON bbox queries, cache responses per amenity+tile, and assemble responses with deduplication and bbox filtering.【specification.md, src/interpreter.ts, src/assemble.ts, src/store.ts】
- Transparently proxy non-cacheable Overpass endpoints and requests to upstream services without changing method or payload semantics.【specification.md, src/interpreter.ts, src/upstream.ts】
- Provide cache statistics endpoints and HTML dashboards for operators to monitor cache coverage and request hotspots.【specification.md, README.md, src/stats.ts, public/statistics-map.html】
- Support cache invalidation for a bbox using a shared secret, with multiple input formats for the bbox values.【README.md, src/interpreter.ts】

### Out of Scope / Non-goals
- Caching non-amenity or non-JSON Overpass queries; such requests are proxied upstream without caching.【specification.md, src/interpreter.ts】
- Serving partial results when cache misses remain unresolved; must return an error response instead of partial data.【specification.md, src/interpreter.ts】
- Enforcing request rate limiting using the `TokenBucket` utility; it exists as a future capability but is not wired into the request flow.【specification.md, src/rateLimit.ts】

## 2. Personas / Stakeholders (if applicable)
- **Client app developers (e.g., ToiletFinder)** need an Overpass-compatible endpoint with faster amenity queries without changing client request patterns.【specification.md, README.md】
- **Operators/SREs** need visibility into cache coverage and demand, and the ability to invalidate cache data when required.【specification.md, README.md, public/statistics-map.html, public/cache-invalidator.html】
- **Integration/test engineers** need deterministic tests without requiring Docker in all environments.【README.md, src/tests/integration/testcontainers.ts】
- **Upstream Overpass providers** are affected by request volumes and rate control/daily limits enforced by the proxy.【specification.md, src/upstream.ts】

## 3. Functional Requirements

### FR-001 — Accept Overpass interpreter requests
- **Description:** The service must accept `GET` and `POST` requests to `/api/interpreter` and normalize the query payload from query string or POST body.
- **Priority:** Must
- **Inputs / Triggers:** HTTP GET/POST requests to `/api/interpreter` with query in `data` or `q` parameters or request body.
- **Outputs / Effects:** Normalized query string used for validation and cache decision.
- **Acceptance Criteria (testable):**
  - Given a `POST /api/interpreter` with `Content-Type: application/x-www-form-urlencoded` containing `data=...`, the service reads and processes the query.
  - Given a `GET /api/interpreter?data=...`, the service reads and processes the query.
- **Evidence pointers:** `src/interpreter.ts` (requestBodyToQuery), `src/tests/integration/integration.test.ts` (POST usage).

### FR-002 — Validate cacheable query requirements
- **Description:** The service must only cache Overpass queries that request JSON output and include an `amenity` filter and bounding box.
- **Priority:** Must
- **Inputs / Triggers:** Normalized query string for `/api/interpreter`.
- **Outputs / Effects:** Cacheable requests proceed to cache pipeline; non-cacheable requests are proxied upstream; missing query or bbox results in 400.
- **Acceptance Criteria (testable):**
  - Queries missing `out:json` or `amenity` filter are transparently proxied upstream.
  - Queries missing a bounding box return HTTP 400 with `{ error: 'Bounding box required' }`.
- **Evidence pointers:** `src/interpreter.ts` (hasJsonOutput/hasAmenityFilter/extractBoundingBox checks), `src/bbox.ts` (validation logic), `src/tests/unit/bbox.test.ts`.

### FR-003 — Enforce tile budget limits
- **Description:** The service must compute geohash tiles for the bbox and reject requests exceeding the configured max tile count.
- **Priority:** Must
- **Inputs / Triggers:** Bounding box and configured `TILE_PRECISION` + `MAX_TILES_PER_REQUEST`.
- **Outputs / Effects:** HTTP 413 when tile count exceeds max.
- **Acceptance Criteria (testable):**
  - A request with a bbox that expands to more than `MAX_TILES_PER_REQUEST` returns 413 with an error message.
- **Evidence pointers:** `src/interpreter.ts` (TooManyTilesError), `src/config.ts`, `specification.md` (tile budget), `src/tests/integration/integration.test.ts` (tile limit).

### FR-004 — Read cache tiles by amenity and hash
- **Description:** The service must read cached tiles by amenity and geohash and identify missing and stale entries.
- **Priority:** Must
- **Inputs / Triggers:** Computed tile list and normalized amenity string.
- **Outputs / Effects:** Distinguish fresh vs stale vs missing tiles, and determine cache disposition.
- **Acceptance Criteria (testable):**
  - Cached tiles can be read and returned; stale tiles are marked and may trigger refresh.
- **Evidence pointers:** `src/store.ts` (readTiles), `src/tests/unit/store.test.ts` (stale handling), `specification.md` (SWR logic).

### FR-005 — Fetch missing/stale tiles from upstream
- **Description:** For missing or stale tiles, the service must fetch upstream data using canonical amenity bbox queries and write tile responses to Redis.
- **Priority:** Must
- **Inputs / Triggers:** Missing/stale tile groups planned by coarse precision grouping.
- **Outputs / Effects:** Upstream fetches return JSON responses; tiles are persisted and coverage marked dirty.
- **Acceptance Criteria (testable):**
  - When cache misses occur, upstream is called and cache is populated; subsequent requests should hit cache.
- **Evidence pointers:** `src/interpreter.ts` (fetchTile/writeTiles), `src/upstream.ts` (buildTileQuery/fetch), `src/tests/integration/integration.test.ts` (cache warm/hit).

### FR-006 — Stale-while-revalidate behavior
- **Description:** When configured, if cache fully covers the request but tiles are stale, the service must return stale data immediately and refresh in background; otherwise, it must await refresh.
- **Priority:** Must
- **Inputs / Triggers:** Stale tiles detected and `SERVE_STALE_FROM_CACHE` config.
- **Outputs / Effects:** Response served from stale cache or after refresh; background refresh queue tasks are enqueued when appropriate.
- **Acceptance Criteria (testable):**
  - With `SERVE_STALE_FROM_CACHE=false`, stale tiles are refreshed before responding.
  - With `SERVE_STALE_FROM_CACHE=true`, fully cached requests return without waiting for refresh.
- **Evidence pointers:** `specification.md` (SWR rules), `src/interpreter.ts` (shouldDeferStaleRefresh), `src/tests/integration/integration.test.ts` (stale refresh behavior).

### FR-007 — Assemble final response and apply conditional headers
- **Description:** The service must merge tile responses, deduplicate elements, filter by bbox, and apply ETag conditional responses.
- **Priority:** Must
- **Inputs / Triggers:** Tile responses list and request headers (`If-None-Match`).
- **Outputs / Effects:** JSON response body or 304 with headers.
- **Acceptance Criteria (testable):**
  - Combined response deduplicates elements and filters by bbox.
  - Matching ETag yields 304 without body.
- **Evidence pointers:** `src/assemble.ts`, `src/headers.ts`, `src/tests/unit/assemble.test.ts`, `src/tests/unit/headers.test.ts`.

### FR-008 — Return cache metadata headers
- **Description:** The service must set `X-Cache` and `X-Cache-Fetched-At` headers for cacheable interpreter responses.
- **Priority:** Must
- **Inputs / Triggers:** Cache disposition and per-tile fetched timestamps.
- **Outputs / Effects:** Response headers indicating cache status and oldest fetch time.
- **Acceptance Criteria (testable):**
  - Responses include `X-Cache` with values `HIT`, `STALE`, or `MISS`.
  - Responses include `X-Cache-Fetched-At` when cached tiles exist.
- **Evidence pointers:** `src/interpreter.ts`, `src/tests/integration/integration.test.ts` (fetched-at header).

### FR-009 — Transparent proxy for non-cacheable endpoints
- **Description:** The service must proxy `/api/*` endpoints and any non-cacheable `/api/interpreter` requests to upstream without modifying method or payload.
- **Priority:** Must
- **Inputs / Triggers:** Non-cacheable requests or `TRANSPARENT_ONLY=true`.
- **Outputs / Effects:** Upstream response forwarded to client.
- **Acceptance Criteria (testable):**
  - `/api/status`, `/api/timestamp`, `/api/kill_my_queries`, and arbitrary `/api/*` paths are forwarded upstream.
- **Evidence pointers:** `specification.md` (Transparent Proxy Behaviour), `src/interpreter.ts` (proxyTransparent usage), `src/upstream.ts`.

### FR-010 — Provide statistics endpoints
- **Description:** The service must expose `/api/statistics`, `/api/statistics/cacheCoverage`, `/api/statistics/cacheCoverage/area`, and `/api/statistics/geohashCoverage` endpoints.
- **Priority:** Must
- **Inputs / Triggers:** HTTP GET to statistics endpoints.
- **Outputs / Effects:** JSON snapshots or 202 with pending status during refresh.
- **Acceptance Criteria (testable):**
  - Statistics endpoints return JSON with appropriate fields and 202 when pending.
- **Evidence pointers:** `src/interpreter.ts`, `src/stats.ts`, `specification.md` (Statistics section), `src/tests/unit/stats.test.ts`.

### FR-011 — Cache invalidation by bbox with secret
- **Description:** The service must allow cache invalidation within a bbox when `CACHE_INVALIDATION_SECRET` is configured and presented.
- **Priority:** Must
- **Inputs / Triggers:** `POST /api/cache/invalidate` with secret and bbox values (query or JSON body).
- **Outputs / Effects:** Deletes cached tiles and returns summary of affected keys and amenities.
- **Acceptance Criteria (testable):**
  - Requests without configured secret or with wrong secret return 403.
  - Requests with missing bbox return 400.
  - Valid requests return `ok: true` and deletion summary.
  - Automated tests cover secret validation and bbox parsing paths for invalidation. (Reconstruction Assumption)
- **Evidence pointers:** `src/interpreter.ts`, `README.md` (API behavior), `specification.md` (cache invalidation).

### FR-012 — Upstream pool availability and limits
- **Description:** The service must manage multiple upstream URLs with cooldowns and daily request limit enforcement.
- **Priority:** Should
- **Inputs / Triggers:** Upstream errors, configured `UPSTREAM_DAILY_LIMIT`, request attempts.
- **Outputs / Effects:** Skip exhausted/cooldown upstreams, rotate to available upstreams.
- **Acceptance Criteria (testable):**
  - Upstream failure applies cooldown/backoff; daily limit exhaustion blocks for 24 hours.
- **Evidence pointers:** `specification.md` (Upstream Daily Request Limits), `src/upstream.ts`, `.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md`.

## 4. Non-Functional Requirements

### Performance
- Cacheable requests must be limited to `MAX_TILES_PER_REQUEST` (default 1024) to cap processing cost; requests exceeding the limit return 413.【specification.md, src/config.ts, src/interpreter.ts】
- Stale cache responses should be served immediately when full coverage is available and `SERVE_STALE_FROM_CACHE=true` to minimize latency.【specification.md, src/interpreter.ts】

### Reliability
- When cache misses cannot be resolved from upstream, the service must return 503 rather than partial data to avoid inconsistent client state.【specification.md, src/interpreter.ts】
- Redis-backed statistics and cache presence should survive restarts to avoid loss of operational state.【specification.md, src/stats.ts, src/store.ts】

### Security / Privacy
- Cache invalidation must require a shared secret when enabled and reject unauthorized requests with 403.【src/interpreter.ts, README.md】
- CORS is permissive to allow browser clients; this is a known exposure and must be explicitly configured only if acceptable in deployment. **Reconstruction Assumption:** No restrictive origin policy is required for current deployments.【src/index.ts, .specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md】

### Maintainability
- Configuration must be environment-driven with defaults documented and centrally loaded in `loadConfig` for predictable deployments.【src/config.ts, README.md】
- Core logic should be modularized into focused files (interpreter, store, upstream, stats) to keep maintenance boundaries clear.【src/*.ts, docs/PROJECT_MAP_AND_EVIDENCE_INDEX.md】

### Testability
- Unit tests must cover bbox parsing, tiling, cache store semantics, and headers; integration tests must validate cache hit/miss cycles with optional Docker dependencies.【specification.md, README.md, src/tests/unit/*.test.ts, src/tests/integration/integration.test.ts】

### Observability
- Structured logging must record incoming requests and POST body summaries for diagnostics and audits.【src/index.ts, .specstory/history/2025-10-28_13-19Z-add-more-logging-for-requests.md】
- Statistics endpoints must expose cache hit/miss/stale counts, tile coverage, and hotspots for dashboards.【specification.md, src/stats.ts, public/statistics-map.html】
- Cache coverage and geohash coverage payloads must be bounded via compaction to prevent unbounded responses.【src/stats.ts, src/tests/unit/stats.test.ts】

## 5. Data Requirements

### Sources
- Upstream Overpass API responses for amenity queries are the authoritative data source for tile cache entries.【specification.md, src/upstream.ts】

### Storage expectations
- Redis must store tile payloads (`response`, `fetchedAt`, `expiresAt`) and cache coverage counters, keyed by amenity+geohash, with TTL for SWR refresh windows.【specification.md, src/store.ts】
- Statistics snapshots and upstream pool state are persisted in Redis for continuity across restarts.【specification.md, src/stats.ts, src/upstream.ts】

### Integrity rules
- Cached responses must be clipped to each tile’s bbox when stored, and assembled responses must be deduplicated by `(type,id)` and filtered to request bbox on return.【specification.md, src/store.ts, src/assemble.ts】

### Retention
- Tile entries remain in Redis beyond TTL but are marked stale; SWR refresh updates payloads while retaining keys for continuity.【specification.md, src/store.ts】
- Statistics are persisted and retained across restarts; snapshot caching uses TTL-based refresh intervals. **Reconstruction Assumption:** No automatic purge schedule beyond TTL refresh behavior is required.【specification.md, src/stats.ts】

## 6. Constraints

### Technical
- Node.js 20+ runtime with TypeScript compilation to `dist/` for production `npm start` runs.【package.json, README.md】
- Redis must be reachable; cacheable requests depend on Redis availability (Redis failures result in 500s).【src/index.ts, .specstory/history/2025-10-28_13-42Z-redis-connection-refused-errors.md】

### Architectural
- Only amenity JSON bbox queries are cached; other Overpass queries are proxied as-is to maintain API compatibility.【specification.md, src/interpreter.ts】
- Tile cache key format is fixed (`tile:<amenity>:<geohash>`) and used across cache, coverage, and invalidation flows.【specification.md, src/store.ts, src/tiling.ts】

### Operational
- Operators must manage `CACHE_INVALIDATION_SECRET` when cache invalidation is required and must consider permissive CORS exposure for browser use cases.【README.md, src/interpreter.ts, src/index.ts】
- Upstream daily limits (`UPSTREAM_DAILY_LIMIT`) can block upstreams for 24 hours; operations must plan capacity accordingly.【specification.md, src/upstream.ts】

### Organizational
- CI and developer workflows depend on `npm test` and `npm run test:ci` with Vitest coverage thresholds; optional Docker-based tests exist for integration coverage.【README.md, vitest.config.ts, src/tests/integration/testcontainers.ts】

## 7. Success Metrics & Acceptance
- **Cache effectiveness:** measurable cache hit rate and reduced upstream requests; must be observable via `/api/statistics` cache status counts and hit rate.【specification.md, src/stats.ts】
- **Latency improvement:** cache hits should return without upstream fetches; integration tests should confirm repeated queries do not hit upstream again.【src/tests/integration/integration.test.ts】
- **Operational visibility:** statistics endpoints and dashboards must render cache coverage and hotspots for operators.【specification.md, README.md, public/statistics-map.html】
- **Correctness:** responses must include only elements within the requested bbox and be deduplicated across tiles.【src/assemble.ts, src/tests/unit/assemble.test.ts】

## 8. Risks & Mitigations
- **Risk:** Redis outage causes cacheable request failures. **Mitigation:** Monitor Redis health; consider `TRANSPARENT_ONLY=true` fallback if Redis is unavailable (operational policy required). **Reconstruction Assumption:** Failover policy is handled operationally, not in code.【src/config.ts, .specstory/history/2025-10-28_13-42Z-redis-connection-refused-errors.md】
- **Risk:** Upstream Overpass instability leads to 503 responses. **Mitigation:** Use multiple upstream URLs and daily limits/backoff logic; monitor upstream metrics in statistics snapshots.【specification.md, src/upstream.ts, src/stats.ts】
- **Risk:** Permissive CORS allows broader access than intended. **Mitigation:** Deploy behind trusted domains or adjust CORS policy if needed. **Reconstruction Assumption:** Open CORS is acceptable for current deployments.【src/index.ts, .specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md】
- **Risk:** Large bbox requests can cause excessive tile counts. **Mitigation:** Enforce `MAX_TILES_PER_REQUEST` and return 413 with guidance to reduce area.【specification.md, src/interpreter.ts】

## 9. Traceability Appendix

- **FR-001** → `src/interpreter.ts` (query parsing), `src/tests/integration/integration.test.ts` (POST interpreter).
- **FR-002** → `src/bbox.ts`, `src/interpreter.ts`, `src/tests/unit/bbox.test.ts`.
- **FR-003** → `src/interpreter.ts`, `src/config.ts`, `src/tests/integration/integration.test.ts`.
- **FR-004** → `src/store.ts`, `src/tests/unit/store.test.ts`.
- **FR-005** → `src/interpreter.ts`, `src/upstream.ts`, `src/tests/integration/integration.test.ts`.
- **FR-006** → `src/interpreter.ts`, `specification.md`, `src/tests/integration/integration.test.ts`.
- **FR-007** → `src/assemble.ts`, `src/headers.ts`, `src/tests/unit/assemble.test.ts`, `src/tests/unit/headers.test.ts`.
- **FR-008** → `src/interpreter.ts`, `src/tests/integration/integration.test.ts`.
- **FR-009** → `src/interpreter.ts`, `src/upstream.ts`, `specification.md`.
- **FR-010** → `src/interpreter.ts`, `src/stats.ts`, `src/tests/unit/stats.test.ts`.
- **FR-011** → `src/interpreter.ts`, `README.md`.
- **FR-012** → `src/upstream.ts`, `specification.md`, `.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md`.
