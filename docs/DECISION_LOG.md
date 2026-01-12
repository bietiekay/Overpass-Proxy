# DECISION LOG (ADR-STYLE)

## 1. Decision Summary Index

| ADR ID | Title | Status | Evidence pointers |
| --- | --- | --- | --- |
| ADR-001 | Proxy Overpass API while adding amenity-focused JSON bbox caching | Accepted | specification.md; README.md; src/interpreter.ts |
| ADR-002 | Enforce JSON + amenity + bbox as cacheability gate | Accepted | specification.md; src/interpreter.ts; src/bbox.ts |
| ADR-003 | Use geohash tiling with per-amenity tile keys | Accepted | specification.md; src/tiling.ts; src/store.ts |
| ADR-004 | Enforce tile budget limit and return 413 on overflow | Accepted | specification.md; src/interpreter.ts |
| ADR-005 | Stale-while-revalidate behavior with refresh locks | Accepted | specification.md; src/store.ts; src/interpreter.ts |
| ADR-006 | Return 503 for unresolved cache misses rather than partial data | Accepted | specification.md; src/interpreter.ts |
| ADR-007 | Deduplicate and bbox-filter assembled responses | Accepted | src/assemble.ts; src/tests/unit/assemble.test.ts |
| ADR-008 | Use ETag conditional responses for cacheable payloads | Accepted | src/headers.ts; src/tests/unit/headers.test.ts |
| ADR-009 | Maintain transparent proxy for non-cacheable endpoints | Accepted | specification.md; src/interpreter.ts |
| ADR-010 | Expose statistics and cache coverage endpoints | Accepted | specification.md; src/stats.ts; src/interpreter.ts |
| ADR-011 | Persist statistics in Redis with worker-driven refresh | Accepted | specification.md; src/stats.ts; src/statsWorker.ts |
| ADR-012 | Support cache invalidation with shared secret | Accepted | README.md; src/interpreter.ts |
| ADR-013 | Implement upstream pool with cooldowns and daily limits | Accepted | specification.md; src/upstream.ts |
| ADR-014 | Add CORS headers for browser-based access | Accepted | src/index.ts; .specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md |
| ADR-015 | Log incoming requests and POST body summaries | Accepted | src/index.ts; .specstory/history/2025-10-28_13-19Z-add-more-logging-for-requests.md |
| ADR-016 | Bind local docker ports to localhost and remap proxy port | Accepted | .specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md |
| ADR-017 | Remove mock Overpass service from compose and use external upstream | Accepted | .specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md |
| ADR-018 | Prefer POST for `/api/interpreter` requests | Accepted | .specstory/history/2025-12-05_14-08Z-overpass-proxy-post-request-for-api.md; src/interpreter.ts |
| ADR-019 | Plan weighted upstream routing and probes | Proposed (Planned) | .specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md; src/upstream.ts |
| ADR-020 | Use in-memory Redis + mock Overpass for non-Docker tests | Accepted | README.md; src/tests/integration/testcontainers.ts |
| ADR-021 | Log bbox and tile read/write flow for cacheable requests | Accepted | .specstory/history/2025-10-28_13-07Z-add-logging-for-request-handling-flow.md; src/interpreter.ts |

## 2. Full ADR Entries

### ADR-001 — Proxy Overpass API while adding amenity-focused JSON bbox caching
- **Context:** Clients needed a drop-in Overpass endpoint with improved performance for amenity queries while preserving behavior for other endpoints.
- **Decision:** Implement a Fastify proxy that mirrors `/api/*` but applies caching to amenity-focused JSON bbox queries.
- **Alternatives considered:**
  - Build a bespoke API instead of mirroring Overpass.
  - Cache all Overpass query types.
- **Why alternatives were rejected:**
  - Non-compatible APIs would break existing clients; caching all queries increases complexity and risk.
- **Consequences (positive / negative):**
  - ✅ Clients can swap endpoints without behavior changes.
  - ❌ Cacheability limited to amenity JSON bbox queries only.
- **Follow-ups:** Monitor cache hit rates and evaluate whether to expand cacheable query support. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; README.md; src/interpreter.ts.

### ADR-002 — Enforce JSON + amenity + bbox as cacheability gate
- **Context:** Cache pipeline assumes JSON responses scoped to a bounding box and segmented by amenity.
- **Decision:** Cache only requests with `out:json`, an `amenity` filter, and a valid bbox; otherwise proxy upstream.
- **Alternatives considered:**
  - Attempt to parse and cache broader query types.
  - Cache without enforcing amenity filter.
- **Why alternatives were rejected:**
  - Broader parsing increases risk of incorrect caching and response filtering.
- **Consequences (positive / negative):**
  - ✅ Predictable cache segmentation and bbox trimming.
  - ❌ Users must ensure amenity + bbox presence or caching is bypassed.
- **Follow-ups:** Document valid query examples and validation errors (existing in README). 
- **Evidence pointers:** specification.md; src/interpreter.ts; src/bbox.ts; src/tests/unit/bbox.test.ts.

### ADR-003 — Use geohash tiling with per-amenity tile keys
- **Context:** Bounding boxes must be cached in reusable spatial chunks to maximize cache reuse.
- **Decision:** Use geohash tiles at configured precision, keying cache entries as `tile:<amenity>:<geohash>`.
- **Alternatives considered:**
  - Cache full bbox requests as single entries.
  - Use a grid index not based on geohash.
- **Why alternatives were rejected:**
  - Full bbox caching yields low reuse; non-geohash grids complicate interoperability and tooling.
- **Consequences (positive / negative):**
  - ✅ Tile reuse across overlapping viewports; amenity segmentation prevents cross-contamination.
  - ❌ Tile explosion for large bboxes; requires tile limits.
- **Follow-ups:** Reevaluate tile precision defaults if viewport sizes change. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/tiling.ts; src/store.ts.

### ADR-004 — Enforce tile budget limit and return 413 on overflow
- **Context:** Large bboxes can generate unbounded tile counts and overwhelm upstream or Redis.
- **Decision:** Enforce `MAX_TILES_PER_REQUEST` and return HTTP 413 when exceeded.
- **Alternatives considered:**
  - Allow large requests with no cap.
  - Silently truncate tiles.
- **Why alternatives were rejected:**
  - No cap risks resource exhaustion; truncation yields partial/incorrect responses.
- **Consequences (positive / negative):**
  - ✅ Predictable resource usage.
  - ❌ Clients must reduce bbox size when exceeding limits.
- **Follow-ups:** Communicate expected bbox limits to client teams. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/interpreter.ts.

### ADR-005 — Stale-while-revalidate behavior with refresh locks
- **Context:** Cache hits should be fast while ensuring updates; stale tiles should refresh without stampedes.
- **Decision:** Serve stale data immediately only when cache fully covers request and `SERVE_STALE_FROM_CACHE=true`; refresh in background with per-tile locks.
- **Alternatives considered:**
  - Always block for refresh.
  - Always serve stale regardless of missing tiles.
- **Why alternatives were rejected:**
  - Always blocking adds latency; always stale with misses yields partial/inconsistent data.
- **Consequences (positive / negative):**
  - ✅ Low latency for fully cached regions.
  - ❌ Complexity in refresh queues and lock handling.
- **Follow-ups:** Monitor stale refresh queue behavior and tune SWR windows. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/store.ts; src/interpreter.ts.

### ADR-006 — Return 503 for unresolved cache misses rather than partial data
- **Context:** Partial data can mislead client applications if some tiles fail upstream.
- **Decision:** If tiles remain unresolved after upstream fetch attempts, respond with 503 and cache metadata headers.
- **Alternatives considered:**
  - Return partial data and annotate missing tiles.
- **Why alternatives were rejected:**
  - Partial data complicates client logic and can be misinterpreted.
- **Consequences (positive / negative):**
  - ✅ Consistent data integrity.
  - ❌ More errors during upstream failures.
- **Follow-ups:** Evaluate fallback strategies if 503 becomes frequent. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/interpreter.ts.

### ADR-007 — Deduplicate and bbox-filter assembled responses
- **Context:** Tiles can overlap and return duplicate elements; responses must match requested bbox.
- **Decision:** Deduplicate by `(type,id)` and filter elements against request bbox when assembling final response.
- **Alternatives considered:**
  - Return raw merged tile responses.
- **Why alternatives were rejected:**
  - Raw merging yields duplicates and out-of-bbox elements.
- **Consequences (positive / negative):**
  - ✅ Correct, bounded responses.
  - ❌ Additional processing overhead.
- **Follow-ups:** Monitor performance for large tile merges. (Reconstruction Assumption)
- **Evidence pointers:** src/assemble.ts; src/tests/unit/assemble.test.ts.

### ADR-008 — Use ETag conditional responses for cacheable payloads
- **Context:** Clients can avoid re-downloading identical responses.
- **Decision:** Generate weak ETags and respond with 304 on `If-None-Match` match.
- **Alternatives considered:**
  - No conditional responses.
- **Why alternatives were rejected:**
  - Missed opportunity for bandwidth savings and client caching.
- **Consequences (positive / negative):**
  - ✅ Reduced payload transfer when unchanged.
  - ❌ Requires consistent JSON serialization for hashing.
- **Follow-ups:** Ensure payload serialization remains stable across changes. (Reconstruction Assumption)
- **Evidence pointers:** src/headers.ts; src/tests/unit/headers.test.ts.

### ADR-009 — Maintain transparent proxy for non-cacheable endpoints
- **Context:** Overpass clients may call endpoints beyond `/api/interpreter`.
- **Decision:** Proxy non-cacheable endpoints and requests to upstream verbatim.
- **Alternatives considered:**
  - Only support cached interpreter endpoint.
- **Why alternatives were rejected:**
  - Loss of compatibility with existing clients.
- **Consequences (positive / negative):**
  - ✅ Compatibility preserved.
  - ❌ Additional upstream traffic for non-cacheable endpoints.
- **Follow-ups:** Monitor upstream load from transparent routes. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/interpreter.ts.

### ADR-010 — Expose statistics and cache coverage endpoints
- **Context:** Operators need cache health, coverage, and demand insights.
- **Decision:** Provide statistics endpoints and separate cache coverage snapshots.
- **Alternatives considered:**
  - Logging-only observability.
- **Why alternatives were rejected:**
  - Operators need structured, queryable metrics and dashboards.
- **Consequences (positive / negative):**
  - ✅ Operational visibility and dashboard support.
  - ❌ Additional data processing and storage.
- **Follow-ups:** Continue to bound payload sizes via compaction. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/stats.ts; src/interpreter.ts.

### ADR-011 — Persist statistics in Redis with worker-driven refresh
- **Context:** Statistics should survive restarts and avoid blocking main request flow.
- **Decision:** Persist statistics and coverage snapshots in Redis; use worker thread to refresh snapshots and handle queued tasks.
- **Alternatives considered:**
  - In-memory-only stats without persistence.
  - Synchronous snapshot generation on request.
- **Why alternatives were rejected:**
  - In-memory stats reset on restart; synchronous work increases latency.
- **Consequences (positive / negative):**
  - ✅ Resilient, asynchronous metrics generation.
  - ❌ Additional complexity with worker communication.
- **Follow-ups:** Monitor worker health and backlog size. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/stats.ts; src/statsWorker.ts.

### ADR-012 — Support cache invalidation with shared secret
- **Context:** Operators need a safe way to invalidate cached tiles by bbox.
- **Decision:** Add `POST /api/cache/invalidate` requiring `CACHE_INVALIDATION_SECRET` and bbox input formats.
- **Alternatives considered:**
  - No invalidation endpoint.
  - Unauthenticated invalidation.
- **Why alternatives were rejected:**
  - No invalidation makes corrections difficult; unauthenticated access is unsafe.
- **Consequences (positive / negative):**
  - ✅ Controlled cache removal for operational needs.
  - ❌ Requires secret management and operator access control.
- **Follow-ups:** Provide UI for invalidation (implemented). 
- **Evidence pointers:** README.md; src/interpreter.ts; public/cache-invalidator.html.

### ADR-013 — Implement upstream pool with cooldowns and daily limits
- **Context:** Upstream Overpass endpoints can fail or impose quotas; routing needs resilience.
- **Decision:** Track upstream state, cooldowns, and daily limits; avoid blocked upstreams and enforce 24h blocks when limits hit.
- **Alternatives considered:**
  - Single upstream with no cooldowns.
- **Why alternatives were rejected:**
  - Single upstream increases outage risk and rate-limit exposure.
- **Consequences (positive / negative):**
  - ✅ Better resilience to upstream failures.
  - ❌ Added state tracking and selection complexity.
- **Follow-ups:** Weighted routing and probes planned. (Reconstruction Assumption)
- **Evidence pointers:** specification.md; src/upstream.ts; .specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md.

### ADR-014 — Add CORS headers for browser-based access
- **Context:** Browser clients (overpass-turbo) encountered CORS policy blocks.
- **Decision:** Add permissive CORS headers (`Access-Control-Allow-Origin: *`, methods/headers) on responses.
- **Alternatives considered:**
  - Restrict CORS to specific origins.
- **Why alternatives were rejected:**
  - Immediate need for broad browser compatibility.
- **Consequences (positive / negative):**
  - ✅ Browser access enabled.
  - ❌ Broader exposure; may require future tightening.
- **Follow-ups:** Consider origin whitelisting if required. (Reconstruction Assumption)
- **Evidence pointers:** src/index.ts; .specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md.

### ADR-015 — Log incoming requests and POST body summaries
- **Context:** Operational debugging required visibility into request flow and payloads.
- **Decision:** Log request metadata and POST body summaries at ingress.
- **Alternatives considered:**
  - Minimal logging only on errors.
- **Why alternatives were rejected:**
  - Insufficient data to debug query parsing and upstream issues.
- **Consequences (positive / negative):**
  - ✅ Improved troubleshooting.
  - ❌ Potential exposure of request data in logs.
- **Follow-ups:** Review log redaction policy. (Reconstruction Assumption)
- **Evidence pointers:** src/index.ts; .specstory/history/2025-10-28_13-19Z-add-more-logging-for-requests.md.

### ADR-016 — Bind local docker ports to localhost and remap proxy port
- **Context:** Local deployment required restricting port exposure.
- **Decision:** Bind ports to `127.0.0.1` and map proxy external port to 5002.
- **Alternatives considered:**
  - Expose ports on all interfaces.
- **Why alternatives were rejected:**
  - Unnecessary exposure for local environments.
- **Consequences (positive / negative):**
  - ✅ Reduced local network exposure.
  - ❌ Requires clients to use port 5002 locally.
- **Follow-ups:** None.
- **Evidence pointers:** .specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md.

### ADR-017 — Remove mock Overpass service from compose and use external upstream
- **Context:** Deployment desired real upstream rather than mock Overpass service in compose.
- **Decision:** Configure `UPSTREAM_URL` to external Overpass and remove mock service from compose dependencies.
- **Alternatives considered:**
  - Keep mock service for local-only deployments.
- **Why alternatives were rejected:**
  - External upstream is needed for real-world data and usage.
- **Consequences (positive / negative):**
  - ✅ Compose aligns with production behavior.
  - ❌ Local testing without external network may be harder.
- **Follow-ups:** Keep mock for tests (in test harness). 
- **Evidence pointers:** .specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md; src/tests/integration/mock-overpass.ts.

### ADR-018 — Prefer POST for `/api/interpreter` requests
- **Context:** GET-based Overpass interpreter requests were unreliable in some cases.
- **Decision:** Encourage POST usage; ensure POST proxy behavior matches working curl examples.
- **Alternatives considered:**
  - Rely on GET only.
- **Why alternatives were rejected:**
  - POST shown to be more reliable for some upstreams.
- **Consequences (positive / negative):**
  - ✅ Higher success rates for large queries.
  - ❌ Clients may need to change request method.
- **Follow-ups:** Ensure POST headers/params match upstream expectations. (Reconstruction Assumption)
- **Evidence pointers:** .specstory/history/2025-12-05_14-08Z-overpass-proxy-post-request-for-api.md; src/interpreter.ts.

### ADR-019 — Plan weighted upstream routing and probes
- **Context:** Multi-upstream routing needed improvement beyond random selection.
- **Decision:** Plan EWMA-based weighting, probes, and persistence of upstream health metrics (not yet implemented).
- **Alternatives considered:**
  - Keep random selection only.
- **Why alternatives were rejected:**
  - Random selection does not account for latency or failure patterns.
- **Consequences (positive / negative):**
  - ✅ Improved upstream selection (planned).
  - ❌ Additional complexity and testing required.
- **Follow-ups:** Implement and test planned features. (Reconstruction Assumption)
- **Evidence pointers:** .specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md; src/upstream.ts.

### ADR-020 — Use in-memory Redis + mock Overpass for non-Docker tests
- **Context:** CI and local environments may not have Docker available.
- **Decision:** Provide in-memory Redis and embedded mock Overpass server for integration tests when Docker is unavailable.
- **Alternatives considered:**
  - Require Docker for all integration tests.
- **Why alternatives were rejected:**
  - Docker availability is inconsistent in CI and developer machines.
- **Consequences (positive / negative):**
  - ✅ Tests can run in constrained environments.
  - ❌ Mocked behavior may differ from real upstream behavior.
- **Follow-ups:** Keep mock behavior aligned with upstream contract. (Reconstruction Assumption)
- **Evidence pointers:** README.md; src/tests/integration/testcontainers.ts; src/tests/integration/mock-overpass.ts.

### ADR-021 — Log bbox and tile read/write flow for cacheable requests
- **Context:** Operators requested visibility into requested bbox coordinates and Redis tile read/write activity during cacheable requests.
- **Decision:** Add logging around cacheable request handling to capture bbox and tile read/write details.
- **Alternatives considered:**
  - Log only high-level request metadata without bbox or tile details.
- **Why alternatives were rejected:**
  - Insufficient detail for diagnosing cache misses and upstream request volumes.
- **Consequences (positive / negative):**
  - ✅ Improved operational troubleshooting of cache behavior.
  - ❌ Increased log verbosity and potential volume.
- **Follow-ups:** Review log volume and add redaction if needed. (Reconstruction Assumption)
- **Evidence pointers:** .specstory/history/2025-10-28_13-07Z-add-logging-for-request-handling-flow.md; src/interpreter.ts.

## 3. Reversal & Pivot Timeline

- **Expose ports publicly → Bind to localhost only**: Reduced local exposure; required port remapping to 5002 for proxy access. Impact: safer local deployment with explicit port usage.【.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md】
- **Use mock Overpass in compose → Use external upstream in compose**: Aligns compose with production, but reduces offline/local independence. Impact: dependency on external network for compose runs.【.specstory/history/2025-10-28_08-42Z-change-proxy-port-to-localhost.md】
- **Allow browser access without CORS → Add permissive CORS**: Enabled browser-based clients; increased exposure footprint. Impact: improved compatibility with overpass-turbo use case.【.specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md】
- **Random upstream selection → Planned weighted/probed selection**: Intends to improve reliability and latency. Impact: future complexity and testing scope increase.【.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md】
- **GET tolerance → Prefer POST for interpreter**: Improves request success rate for complex payloads. Impact: clients may adjust request method and headers.【.specstory/history/2025-12-05_14-08Z-overpass-proxy-post-request-for-api.md】
