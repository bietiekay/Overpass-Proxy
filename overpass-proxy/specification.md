# Overpass Proxy Specification

## 1. Purpose and Context
The Overpass Proxy is a Fastify-based Node.js 20 service that mirrors the public Overpass API surface while adding optional Redis-backed tile caching for JSON bounding-box (bbox) queries. It enables ToiletFinder clients to switch endpoints without behavioural changes while benefiting from faster, cached responses for map tiles. The proxy can run as a standalone deployment, via Docker Compose, or locally in developer environments with or without Docker.

## 2. Architectural Overview
- **Entry point:** `src/index.ts` builds and starts a Fastify server, wiring configuration, Redis connections, and route registration. Redis connectivity can be injected for testing.
- **Routing:** `src/interpreter.ts` declares the `/api/*` routes, distinguishing cacheable Overpass requests from transparent pass-throughs. It enforces tile limits, applies conditional headers, and stamps cache metadata headers.
- **Caching layer:** `src/store.ts` encapsulates Redis read/write access, including TTL and stale-while-revalidate (SWR) handling via refresh locks.
- **Query analysis:** `src/bbox.ts` extracts bbox tuples and detects JSON outputs, while `src/tiling.ts` converts bbox envelopes into geohash tiles.
- **Upstream communication:** `src/upstream.ts` provides helpers to proxy arbitrary Overpass requests and to materialise per-tile JSON queries from bbox coordinates.
- **Response assembly:** `src/assemble.ts` deduplicates and merges cached tile payloads, retaining metadata and filtering by bbox.
- **Supporting utilities:** `src/headers.ts` implements deterministic weak ETags and If-None-Match handling, `src/rateLimit.ts` offers a token-bucket primitive (currently unused but available for future upstream throttling), and `src/errors.ts` defines typed errors (e.g., `TooManyTilesError`).
- **Logging:** `src/logger.ts` exposes the shared Pino logger instance configured for structured output.

## 3. Request Classification Flow
1. **Body extraction:** Incoming `/api/interpreter` requests are normalised to a query string (supporting GET query parameters and POST payloads) before inspection.
2. **Transparent bypass:** If no query exists, caching is disabled (`TRANSPARENT_ONLY`), or the Overpass query does not request JSON output, the request is proxied directly upstream with all headers and status codes preserved.
3. **Bounding box detection:** When JSON output is requested, `extractBoundingBox` scans for `bbox:` directives or tuple literals, tolerating comments and whitespace.
4. **Fallback to pass-through:** If no bbox is discovered, the request falls back to transparent proxying to guarantee correctness for complex or non-spatial queries.

### 3.1 End-to-End Runtime Flow
```mermaid
flowchart TD
    subgraph Bootstrap
        A[Load ENV via config.ts] --> B[Create logger (logger.ts)]
        B --> C[Create Redis client (store.ts)]
        C --> D[Instantiate Fastify server (index.ts)]
        D --> E[Register interpreter routes (interpreter.ts)]
    end

    subgraph RequestLifecycle
        F[Inbound request /api/*] --> G{Route match}
        G -->|/api/interpreter| H[Normalize query/body]
        G -->|Other /api path| T[Transparent proxy]
        H --> I{Transparent only?}
        I -->|Yes| T
        I -->|No| J[Check out:json]
        J -->|No| T
        J -->|Yes| K[Extract bbox (bbox.ts)]
        K --> L{BBox found?}
        L -->|No| T
        L -->|Yes| M[Compute tiles (tiling.ts)]
        M --> N{Tiles > MAX?}
        N -->|Yes| U[Throw TooManyTilesError]
        N -->|No| O[Bulk fetch from Redis (store.ts)]
        O --> P{Fresh?}
        P -->|All fresh| Q[Assemble payload (assemble.ts)]
        P -->|Missing/stale| R[Fetch upstream tiles (upstream.ts)]
        R --> S[Persist refreshed tiles (store.ts)]
        S --> Q
        Q --> V[Generate headers (headers.ts)]
        V --> W[Return JSON response]
    end

    T --> X[Proxy upstream via upstream.ts]
    X --> Y[Stream response to client]
    U --> Y
    W --> Y

    Y --> Z[Emit structured logs (logger.ts)]
    W --> AA[Optionally schedule SWR refresh locks (store.ts)]
    R --> AB[Respect rateLimit token bucket (rateLimit.ts, optional)]
    Y --> AC[Errors normalized via errors.ts]
```

## 4. Tile Caching Pipeline
1. **Tile computation:** Detected bbox coordinates are expanded into geohash tiles at `TILE_PRECISION` (default 7). Duplicate hashes are removed.
2. **Tile budget enforcement:** Requests requiring more than `MAX_TILES_PER_REQUEST` tiles raise a `TooManyTilesError`, returning HTTP 413.
3. **Cache lookup:** For each tile, Redis is queried in bulk. Stored payloads include `response`, `fetchedAt`, and `expiresAt` timestamps.
4. **Stale tracking:** Tiles past their TTL are marked `stale` but still served immediately while triggering asynchronous refreshes guarded by a per-tile lock (SWR window `SWR_SECONDS`).
5. **Upstream fetch:** Missing tiles are fetched individually by issuing the canonical Overpass multi-entity bbox query (`node`, `way`, `relation`) via POST `application/x-www-form-urlencoded`.
6. **Persistence:** Fresh tile responses are persisted with a TTL covering both the primary cache duration and SWR window.
7. **Assembly:** All tile responses (cached or freshly fetched) are merged, deduplicated by `(type,id)`, filtered against the original bbox, and returned with `Content-Type: application/json`. The proxy also emits `X-Cache` headers (`HIT`, `STALE`, or `MISS`).
8. **Conditional delivery:** ETags are generated from the assembled JSON payload. Matching `If-None-Match` headers yield a 304 response with no body.

## 5. Transparent Proxy Behaviour
- All non-cacheable `/api/interpreter` requests and every other `/api/*` endpoint (`/api/status`, `/api/timestamp`, `/api/timestamp/*`, `/api/kill_my_queries`, and arbitrary paths) are proxied verbatim.
- The proxy streams binary bodies without transformation, preserves upstream headers (excluding `host`), and relays upstream status codes. Errors contacting the upstream translate to HTTP 502 with a JSON error object.

## 6. Redis Data Model and SWR Locks
- **Primary key format:** `tile:<geohash>`.
- **Payload:** JSON string representing `{ response, fetchedAt, expiresAt }`, where `response` mirrors the Overpass JSON envelope.
- **TTL strategy:** Redis `SET` with PX expiry of `(CACHE_TTL_SECONDS + SWR_SECONDS)` milliseconds, ensuring stale entries remain addressable for refresh locking.
- **Refresh locks:** Temporary keys (`tile:<geohash>:lock`) guard background refreshes for stale tiles, preventing duplicate upstream fetches during the SWR window.

## 7. Configuration Surface
Environment-driven configuration is loaded at startup with sensible defaults:
- `PORT` (default `8080`)
- `UPSTREAM_URL` (default Overpass interpreter endpoint)
- `REDIS_URL`
- `CACHE_TTL_SECONDS` and derived `SWR_SECONDS` (min 30s)
- `TILE_PRECISION`
- `MAX_TILES_PER_REQUEST`
- `TRANSPARENT_ONLY`
- `NODE_ENV`
The `buildServer` helper allows tests to override any configuration or inject custom Redis clients.

## 8. Testing Strategy
- **Unit tests (`src/tests/unit`)** cover bbox parsing, geohash tiling, cache store semantics (including TTL/SWR handling), header utilities, response assembly, and rate limiting.
- **Integration tests (`src/tests/integration`)** exercise transparent pass-through, cache warm/hit cycles, stale refresh behaviour, ETag handling, endpoint parity, tile limit enforcement, and transparent-only mode. The harness can operate entirely in-process (default) or via Testcontainers (`USE_DOCKER=1`).
- **Coverage gates:** Vitest configuration enforces ≥90% line coverage and ≥85% branch coverage. `npm run test:ci` runs the suite with coverage.

## 9. Deployment and Operations
- **Build:** `npm run build` compiles TypeScript to `dist/`.
- **Runtime:** `npm start` executes the compiled server; Fastify listens on `0.0.0.0:PORT`.
- **Docker:** `Dockerfile` (Node 20 Alpine) and `docker-compose.yml` orchestrate the proxy alongside Redis (and mock Overpass in development scenarios).
- **CI:** `.github/workflows/ci.yml` installs dependencies, runs linting, executes tests with coverage, and uploads reports.
- **Observability:** Structured logs include contextual metadata (request IDs, error stacks) through Pino, aiding debugging across deployment targets.

## 10. Future Extensions
- **Rate limiting:** `TokenBucket` utility enables cost-based upstream throttling if Overpass rate limits become a concern.
- **Additional caching heuristics:** Parsing refinements could support more Overpass query variants or integrate element change tracking.
- **Metrics and tracing:** Exporting Prometheus or OpenTelemetry metrics would complement logs for production observability.
