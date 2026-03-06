# TECHNICAL SPECIFICATION

## 1. Architectural Overview

### Logical architecture
- **HTTP proxy service** that exposes `/api/*` Overpass-compatible endpoints and selectively applies cache logic to amenity JSON bbox queries.【specification.md, README.md, src/interpreter.ts】
- **Caching subsystem** that stores and retrieves geohash tile payloads per amenity, with stale-while-revalidate semantics and lock-based refresh control.【specification.md, src/store.ts, src/interpreter.ts】
- **Upstream connector** that builds canonical Overpass queries and routes requests across one or more upstream endpoints with cooldown and daily limit controls.【specification.md, src/upstream.ts】
- **Statistics subsystem** that aggregates request metrics, cache coverage, and upstream state, persisted in Redis and served via JSON endpoints and HTML dashboards.【specification.md, src/stats.ts, public/statistics-map.html】

### Runtime/deployment model
- Node.js 20+ Fastify server started via `src/index.ts`, listening on `0.0.0.0:PORT` with form body support and permissive CORS headers.【package.json, src/index.ts, README.md】
- Redis client initialized at startup; statistics worker (via worker threads) uses Redis for persistence and coverage snapshots.【src/index.ts, src/statsWorker.ts, specification.md】
- Deployable via Docker or local runtime; integration tests can run in-process without Docker by default.【README.md, src/tests/integration/testcontainers.ts】

### Dependency boundaries
- **HTTP layer** (`index.ts`, `interpreter.ts`) depends on config, store, upstream, headers, and stats modules.【src/index.ts, src/interpreter.ts】
- **Store** depends on Redis and geohash utilities; does not depend on HTTP or upstream modules.【src/store.ts, src/tiling.ts】
- **Upstream** depends on HTTP client (`got`) and time helpers; does not depend on Fastify directly (uses request/response only in transparent proxy helpers).【src/upstream.ts, src/time.ts】
- **Stats** depends on store interfaces and Redis storage, optionally on upstream metrics providers; uses a worker to offload snapshot refreshes.【src/stats.ts, src/statsWorker.ts】

## 2. Component Specifications

### 2.1 Server bootstrap (`index.ts`)
- **Responsibility:** Initialize Fastify server, configure CORS, serve HTML dashboards, wire Redis, tile store, and statistics worker, and register interpreter routes.【src/index.ts】
- **Interfaces:**
  - `buildServer(options)` returns `{ app, config }` and allows injecting Redis or config overrides (used in tests).【src/index.ts】
  - HTTP routes for `/statistics-map`, `/cache-preheater`, `/cache-invalidator` serve static HTML from `public/` files.【src/index.ts】
- **Key logic:**
  - Adds `onSend` CORS headers for all responses.
  - Logs incoming requests and POST body summaries (size/preview).【src/index.ts】
  - Initializes Redis and restores cache presence before serving traffic.【src/index.ts, src/store.ts】
- **State & lifecycle:**
  - Redis connection is created on startup and closed on server shutdown unless injected externally.【src/index.ts】
  - Statistics worker client is started and stopped with server lifecycle.【src/index.ts, src/stats.ts】
- **Failure modes:**
  - Redis connection failure yields errors during request handling; server logs errors and may respond 500 on cacheable paths.【src/index.ts, .specstory/history/2025-10-28_13-42Z-redis-connection-refused-errors.md】
- **Evidence pointers:** `src/index.ts`, `specification.md`, `README.md`.

### 2.2 Interpreter routes (`interpreter.ts`)
- **Responsibility:** Handle `/api/interpreter` cacheability checks, caching pipeline, statistics endpoints, cache invalidation, and transparent proxy routing for `/api/*` paths.【src/interpreter.ts】
- **Interfaces:**
  - `GET/POST /api/interpreter` with query body in `data`/`q` or request body.
  - `GET /api/statistics`, `/api/statistics/cacheCoverage`, `/api/statistics/cacheCoverage/area`, `/api/statistics/geohashCoverage`.
  - `POST /api/cache/invalidate` with secret and bbox.
  - `ALL /api/*` for transparent proxy fallback and specific upstream-pass endpoints (`/api/status`, `/api/timestamp`, `/api/kill_my_queries`).【src/interpreter.ts】
- **Key logic:**
  - Parses query body, validates JSON output and amenity filter, extracts bbox, computes tiles, enforces `MAX_TILES_PER_REQUEST`.
  - Reads cache tiles, determines missing/stale lists, optionally defers stale refresh via stats worker queue.
  - Fetches missing/stale tiles from upstream, writes tiles, assembles response, sets `X-Cache` headers, applies ETag conditional response, and records statistics.【src/interpreter.ts】
  - Cache invalidation validates secret and bbox, computes tiles, and deletes tile keys via store.【src/interpreter.ts】
- **State & lifecycle:**
  - Uses `TileStore` for cache I/O and `StatisticsWorkerClient` for recording metrics and enqueuing stale refresh tasks.【src/interpreter.ts】
- **Failure modes:**
  - Missing query or bbox results in 400; too many tiles results in 413; upstream failures with unresolved tiles return 503 with cache headers.【src/interpreter.ts, specification.md】
- **Evidence pointers:** `src/interpreter.ts`, `specification.md`, `src/tests/integration/integration.test.ts`.

### 2.3 Tile store (`store.ts`)
- **Responsibility:** Read/write tile payloads to Redis, manage TTL/SWR, maintain cache presence and coverage summaries, provide lock primitives for refresh/miss handling.【src/store.ts】
- **Interfaces:**
  - `readTiles(tiles, amenity)` -> map of cached tiles with stale markers.
  - `writeTile` / `writeTiles` to store payloads with metadata.
  - `withRefreshLock` / `withMissLock` to guard refresh and miss fetches.
  - `invalidateTiles(tiles)` to delete cache keys.
  - `restorePresence()` to rebuild cache presence on startup.【src/store.ts】
- **Key logic:**
  - Uses key format `tile:<amenity>:<geohash>`.
  - Stores `{ response, fetchedAt, expiresAt }` JSON payloads.
  - Marks cached entries stale when TTL passes; stale entries remain addressable for SWR refresh until overwritten.【src/store.ts, specification.md】
  - Miss-lock waiters are released promptly when a miss handler fails to avoid request pileups.【src/store.ts, src/tests/unit/store.test.ts】
  - Refresh-lock logic preserves newer lock tokens if they change mid-refresh to avoid deleting fresh locks.【src/store.ts, src/tests/unit/store.test.ts】
- **State & lifecycle:**
  - Maintains in-memory presence cache to support coverage queries and statistics.
  - Uses Redis scan to rebuild presence on startup for continuity across restarts.【src/store.ts】
- **Failure modes:**
  - Redis errors can prevent reads/writes; caller must handle missing data or errors accordingly.【src/store.ts】
- **Evidence pointers:** `src/store.ts`, `specification.md`, `src/tests/unit/store.test.ts`.

### 2.4 Upstream connector (`upstream.ts`)
- **Responsibility:** Build Overpass queries for tiles, send upstream requests with retry policies, manage upstream pool state including cooldowns and daily limits, and proxy non-cacheable requests.【src/upstream.ts】
- **Interfaces:**
  - `fetchTile(config, bbox, amenity, options?)` -> Overpass JSON response.
  - `proxyTransparent(request, reply, config, options)` -> forwards request/response.
  - `createUpstreamMetricsProvider` for statistics integration.【src/upstream.ts】
- **Key logic:**
  - Builds canonical Overpass query with `node/way/relation` amenity filter and bbox, using `[out:json][timeout:120];` and an explicit `Accept: application/json` upstream header.
  - If an upstream still answers a valid Overpass XML document for an `out:json` interpreter request, the connector parses the XML into the internal JSON response model so downstream cache assembly and client responses remain JSON-shaped.【src/upstream.ts, src/tests/unit/upstream.test.ts】
  - Retry policies with exponential backoff for retryable status/error codes; avoid retrying 429 responses.【src/upstream.ts】
  - Upstream pool tracks backoff, cooldowns, daily limits; selection avoids blocked or cooling upstreams.【src/upstream.ts, specification.md】
- **State & lifecycle:**
  - Upstream pool state can be persisted in Redis for continuity (via `UpstreamStateStorage`).【src/upstream.ts】
- **Failure modes:**
  - Some Overpass upstreams can still return XML/HTML/text bodies for tile fetch failures even when JSON was requested; the connector classifies these as upstream failures, extracts a short diagnostic when possible, and tries the next upstream before surfacing an error.【src/upstream.ts, src/tests/unit/upstream.test.ts】
  - Valid Overpass XML result documents are not treated as failures; only XML error payloads such as `<remark>` continue to trigger failover/backoff.【src/upstream.ts, src/tests/unit/upstream.test.ts】
  - Upstream errors propagate to caller; interpreter may respond 503 if unresolved tiles remain.【src/interpreter.ts, src/upstream.ts】
- **Evidence pointers:** `src/upstream.ts`, `specification.md`, `src/tests/unit/upstream.test.ts`.

### 2.5 Statistics subsystem (`stats.ts`, `statsWorker.ts`)
- **Responsibility:** Aggregate request metrics, cache coverage snapshots, per-amenity stats, and upstream status; persist snapshots to Redis and expose worker-based refreshes.【src/stats.ts, src/statsWorker.ts】
- **Interfaces:**
  - `RequestStatistics` with `recordRequest`, `getSnapshot`, `getCacheCoverageSnapshot`, `getGeohashCoverageSnapshot`.
  - `StatisticsWorkerClient` for main process to submit record/refresh tasks to worker.
  - Worker commands for record/refresh/dirty/stale refresh tasks.【src/stats.ts, src/statsWorker.ts】
- **Key logic:**
  - Tracks daily/weekly/monthly counters, unique clients, cache hit/miss/stale rates, hotspots, geohash coverage.
  - Compacts geohash coverage entries to bound payload sizes; caches snapshots with TTL and refresh intervals.【src/stats.ts】
- **State & lifecycle:**
  - Uses Redis storage for persistence across restarts; worker thread maintains periodic refresh intervals.
  - Stale refresh queue can be used for background refresh tasks in worker mode.【src/statsWorker.ts, src/staleRefreshQueue.ts】
- **Failure modes:**
  - Redis failures may prevent snapshot persistence; system logs warnings and continues with in-memory state.【src/stats.ts】
- **Evidence pointers:** `src/stats.ts`, `src/statsWorker.ts`, `src/tests/unit/stats.test.ts`.

### 2.6 Stale refresh queue (`staleRefreshQueue.ts`)
- **Responsibility:** Queue and merge stale refresh tasks, enforce timeout on background refresh tasks, and expose queue metrics for statistics.【src/staleRefreshQueue.ts】
- **Interfaces:**
  - `enqueue(task)` to add refresh tasks; `describeQueue()` returns queue metrics for stats.
- **Key logic:**
  - Merges queued tasks by amenity to reduce duplication; enforces task timeout and continues processing after failures/timeouts.【src/staleRefreshQueue.ts】
- **Failure modes:**
  - Task timeouts are logged and queue continues; errors are logged and do not stop queue processing.【src/staleRefreshQueue.ts, src/tests/unit/staleRefreshQueue.test.ts】
- **Evidence pointers:** `src/staleRefreshQueue.ts`, `src/tests/unit/staleRefreshQueue.test.ts`.

### 2.7 Query parsing and tiling (`bbox.ts`, `tiling.ts`, `fetchPlan.ts`)
- **Responsibility:** Parse bbox and amenity filters from Overpass QL, compute geohash tiles, and group tiles for upstream fetch efficiency.【src/bbox.ts, src/tiling.ts, src/fetchPlan.ts】
- **Interfaces:**
  - `extractBoundingBox`, `hasJsonOutput`, `hasAmenityFilter`, `extractAmenityValue`.
  - `tilesForBoundingBox`, `tileKey`, `boundsForHash`.
  - `planTileFetches` groups tiles by coarse geohash prefix and size limits.【src/bbox.ts, src/tiling.ts, src/fetchPlan.ts】
- **Key logic:**
  - Accepts tuple or directive bbox syntax, strips comments, validates numeric coordinates and ordering.【src/bbox.ts】
  - Deduplicates geohashes and preserves precision to avoid mixing stale child tiles in stats.【src/tiling.ts】
  - Groups tiles by coarse precision and bounding area to reduce upstream request count.【src/fetchPlan.ts】
- **Failure modes:**
  - Invalid bbox coordinates throw errors during tile computation, resulting in 400/413 handling upstream in interpreter.
- **Evidence pointers:** `src/bbox.ts`, `src/tiling.ts`, `src/fetchPlan.ts`, `src/tests/unit/bbox.test.ts`, `src/tests/unit/tiling.test.ts`, `src/tests/unit/fetchPlan.test.ts`.

### 2.8 Response assembly and headers (`assemble.ts`, `headers.ts`)
- **Responsibility:** Merge tile responses, deduplicate elements, filter by bbox, and generate ETag/304 responses.【src/assemble.ts, src/headers.ts】
- **Interfaces:**
  - `combineResponses(responses, bbox)` returns a merged Overpass response.
  - `generateEtag(payload)` and `applyConditionalHeaders(request, reply, payload)`.
- **Key logic:**
  - Dedupe by `(type,id)` and clone elements to avoid mutation, filter by bbox for nodes/ways/relations.【src/assemble.ts】
  - Apply weak ETag and return 304 if `If-None-Match` matches.【src/headers.ts】
- **Failure modes:**
  - Invalid payloads for ETag are still hashed via JSON stringify; callers must ensure valid data types.【src/headers.ts】
- **Evidence pointers:** `src/assemble.ts`, `src/headers.ts`, `src/tests/unit/assemble.test.ts`, `src/tests/unit/headers.test.ts`.

## 3. Data Models

### 3.1 BoundingBox
- **Structure:** `{ south: number, west: number, north: number, east: number }`.
- **Invariants:** `south < north` and `west < east`, all finite numbers.【src/bbox.ts】
- **Validation rules:** Parsed from tuple or directive syntax; invalid tuples return null or error upstream.【src/bbox.ts, src/tests/unit/bbox.test.ts】

### 3.2 TileInfo
- **Structure:** `{ hash: string, bounds: BoundingBox }`.
- **Invariants:** `hash` is geohash string of configured precision; bounds derived from geohash decode.【src/tiling.ts】
- **Validation rules:** Tile list computed from valid bbox only; invalid bbox throws error.【src/tiling.ts, src/tests/unit/tiling.test.ts】

### 3.3 Cached tile payload
- **Structure:** `{ response: OverpassResponse, fetchedAt: number, expiresAt: number }` stored as JSON string.
- **Invariants:** `expiresAt` determines stale status; payload is associated with amenity+hash key.
- **Validation rules:** Stored via `TileStore` write methods; stale determination compares `expiresAt` vs `Date.now()`.【src/store.ts, specification.md】

### 3.4 OverpassResponse / OverpassElement
- **Structure:** `{ version, generator, osm3s, elements: OverpassElement[] }` where element types include `node`, `way`, `relation`.
- **Invariants:** Deduplication by `(type,id)` across tiles; elements filtered to request bbox during assembly and per-tile writes.
- **Validation rules:** None enforced beyond filtering and merge; relies on upstream correctness.【src/store.ts, src/assemble.ts, src/tests/unit/assemble.test.ts】

### 3.5 Statistics snapshot
- **Structure:** JSON with totals, per-amenity breakdown, cache status counts, hotspots, and optional coverage snapshots.
- **Invariants:** Snapshot excludes cache coverage by default; coverage snapshots are separate endpoints with bounded sizes.【src/stats.ts, src/tests/unit/stats.test.ts】
- **Validation rules:** Snapshot generation uses cached timestamps; coverage compaction occurs when entries exceed limits.【src/stats.ts】

## 4. Core Workflows

### 4.1 Primary path: cacheable interpreter request
1. Receive `/api/interpreter` request; normalize query.
2. Validate JSON output, amenity filter, and bbox; compute tiles and enforce tile budget.
3. Read cached tiles; identify missing and stale tiles.
4. Refresh stale tiles (defer if fully covered and configured for SWR).
5. Fetch missing tiles upstream and write to cache.
6. Assemble response, apply ETag conditional headers, set `X-Cache` headers, record statistics, and return response.【specification.md, src/interpreter.ts】

### 4.2 Alternate path: non-cacheable interpreter request
1. Receive `/api/interpreter` request without JSON output or amenity filter.
2. Proxy request upstream without caching or validation errors (unless query missing).【src/interpreter.ts, src/upstream.ts】

### 4.3 Alternate path: transparent proxy endpoint
1. Receive `/api/*` request for non-interpreter endpoints.
2. Forward to upstream with original method, headers, and body; return upstream response to client.【specification.md, src/interpreter.ts, src/upstream.ts】

### 4.4 Error paths
- Missing query payload -> 400 with `Query payload required` error.【src/interpreter.ts】
- Missing bbox -> 400 with `Bounding box required` error.【src/interpreter.ts】
- Tile budget exceeded -> 413 with TooManyTilesError message.【src/interpreter.ts】
- Unresolved tiles after upstream failures -> 503 with cache headers and error message.【specification.md, src/interpreter.ts】

### 4.5 Retry/recovery behavior
- Upstream requests retry on selected status/error codes with exponential backoff and jitter; 429 is not retried.【src/upstream.ts】
- Refresh locks and miss locks prevent stampedes and allow waiters to proceed if a fetch fails.【src/store.ts, src/tests/unit/store.test.ts】
- Background stale refresh tasks are merged and time-limited in queue to prevent blocking.【src/staleRefreshQueue.ts】

## 5. External Dependencies & Integrations
- **Redis (ioredis):** Cache storage, presence tracking, statistics persistence, upstream pool state persistence.【src/index.ts, src/store.ts, src/stats.ts, src/upstream.ts】
- **Fastify:** HTTP server and routing framework.【src/index.ts, src/interpreter.ts】
- **got:** HTTP client for upstream Overpass requests with retry logic.【src/upstream.ts】
- **ngeohash:** Geohash computations for tiling and coverage aggregation.【src/tiling.ts, src/store.ts, src/stats.ts】
- **pino:** Structured logging for server and worker diagnostics.【src/logger.ts, src/index.ts】
- **Testcontainers (optional):** Docker-backed Redis for integration tests.【src/tests/integration/testcontainers.ts】

## 6. Configuration

### Parameters and defaults
- `PORT` (default `8080`) — HTTP listen port.【src/config.ts, README.md】
- `UPSTREAM_URLS` (default unset) — list of upstream Overpass endpoints; fallback to `UPSTREAM_URL` if unset.【src/config.ts, README.md】
- `UPSTREAM_URL` (default `https://overpass-api.de/api/interpreter`) — legacy single upstream endpoint.【src/config.ts, README.md】
- `REDIS_URL` (default `redis://redis:6379`) — Redis connection string.【src/config.ts, README.md】
- `CACHE_TTL_SECONDS` (default `86400`) — primary cache TTL in seconds.【src/config.ts, README.md】
- `SWR_SECONDS` (default `CACHE_TTL_SECONDS/10`, min 30) — stale-while-revalidate window.【src/config.ts, README.md】
- `TILE_PRECISION` (default `5`) — geohash precision for tiles.【src/config.ts, README.md】
- `UPSTREAM_TILE_PRECISION` (default `max(2, TILE_PRECISION-2)`) — coarse precision for upstream grouping.【src/config.ts】
- `MAX_TILES_PER_REQUEST` (default `1024`) — tile budget per request.【src/config.ts, README.md】
- `STALE_REFRESH_COARSE_PRECISION` (default `3`) — coarse precision for stale refresh grouping.【src/config.ts, README.md】
- `STALE_REFRESH_TARGET_TILES_PER_REQUEST` (default `max(32, MAX_TILES_PER_REQUEST/4)`) — batch size target for refresh groups.【src/config.ts, README.md】
- `TRANSPARENT_ONLY` (default `false`) — disable caching and proxy all requests upstream.【src/config.ts, README.md】
- `TRUST_PROXY` (default `false`) — trust `X-Forwarded-For`/`X-Real-IP` for client IP resolution.【src/config.ts, README.md】
- `UPSTREAM_ORIGIN` (default `https://overpass-turbo.eu`) — Origin header for interpreter proxy requests.【src/config.ts, README.md】
- `UPSTREAM_REFERER` (default `https://overpass-turbo.eu/`) — Referer header for interpreter proxy requests.【src/config.ts, README.md】
- `UPSTREAM_DAILY_LIMIT` (default `-1` unlimited) — per-upstream daily request quota.【src/config.ts, specification.md】
- `LOG_VERBOSITY` (default `info`) — logging verbosity mapping to pino log level.【src/config.ts, src/logger.ts】
- `CACHE_INVALIDATION_SECRET` (default unset) — enables cache invalidation endpoint when set.【src/config.ts, README.md】

## 7. Security & Privacy Design (if applicable)
- Cache invalidation requires a shared secret; missing or invalid secret results in 403 and no cache modification.【src/interpreter.ts, README.md】
- CORS headers allow all origins; **Reconstruction Assumption:** permissive access is acceptable due to intended browser usage (overpass-turbo), but deployments may tighten policy if needed.【src/index.ts, .specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md】
- Client IP addresses are logged for requests and stored in statistics (normalized), implying privacy considerations for deployments handling user IPs.【src/index.ts, src/stats.ts, specification.md】

## 8. Performance Considerations
- Tile budget enforcement prevents unbounded processing; default limits tuned for ToiletFinder viewport sizes.【specification.md, README.md, src/interpreter.ts】
- Geohash grouping reduces upstream request count by merging tiles at coarse precision before fetches.【src/fetchPlan.ts, src/interpreter.ts】
- SWR with refresh locks reduces request latency for fully cached regions and prevents duplicate refresh fetches.【specification.md, src/store.ts, src/interpreter.ts】
- Coverage snapshots are compacted to maintain bounded payload sizes for dashboards and API responses.【src/stats.ts, src/store.ts】

## 9. Implementation Notes & Gotchas
- **Query parsing:** Only Overpass QL variants with bbox are cacheable; comments are stripped before bbox and amenity detection.【src/bbox.ts】
- **Amenity normalization:** Amenity names are lowercased for cache segmentation; request may include amenity in query/body/querystring fallback.【src/interpreter.ts】
- **Cache invalidation bbox parsing:** Accepts `bbox` string, array, or separate `south/west/north/east` fields across query/body.【src/interpreter.ts, README.md】
- **Stale refresh queue:** Background refresh tasks may be merged by amenity; long-running tasks timeout to keep queue moving.【src/staleRefreshQueue.ts】
- **Upstream retries:** Retry logic excludes 429; 4xx (e.g., 400) are treated as client errors and do not mark upstream as failed.【src/upstream.ts, src/tests/unit/upstream.test.ts】

## 10. Traceability

### Component-to-PRD mapping
- **Server bootstrap** → FR-001, FR-009, NFR Observability (logging).【docs/PRD.md, src/index.ts】
- **Interpreter routes** → FR-001 to FR-011 (core API behaviors).【docs/PRD.md, src/interpreter.ts】
- **Tile store** → FR-004 to FR-006, Data Requirements (cache payloads).【docs/PRD.md, src/store.ts】
- **Upstream connector** → FR-005, FR-009, FR-012 (upstream management).【docs/PRD.md, src/upstream.ts】
- **Statistics subsystem** → FR-010, NFR Observability, Data Requirements (snapshots).【docs/PRD.md, src/stats.ts】
- **Stale refresh queue** → FR-006 (background refresh), NFR Reliability (timeouts).【docs/PRD.md, src/staleRefreshQueue.ts】
- **Query parsing & tiling** → FR-002, FR-003 (validation and tile budget).【docs/PRD.md, src/bbox.ts, src/tiling.ts】
- **Assembly & headers** → FR-007 (dedupe/bbox filter/ETag).【docs/PRD.md, src/assemble.ts, src/headers.ts】
