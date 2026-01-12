# REIMPLEMENTATION ROADMAP & EVOLUTION GUIDE

## 1. Reimplementation Strategy

### Behavioral compatibility contract
- Reimplementation must preserve the PRD-defined behaviors for `/api/interpreter`, cacheability gates, tile budgeting, cache headers, transparent proxy behavior, statistics endpoints, and cache invalidation semantics as the contract of record.【docs/PRD.md】
- The technical specification describes required component interfaces, workflows, data models, and error paths that must be functionally equivalent in the new system.【docs/TECHNICAL_SPECIFICATION.md】
- ADR decisions (e.g., SWR, 503 on unresolved tiles, transparent proxy) are binding unless explicitly superseded by new ADRs during the reimplementation program.【docs/DECISION_LOG.md】

### Guiding principles
- Preserve API surface and response semantics over internal architecture changes; the proxy must remain drop-in compatible for Overpass clients.【docs/PRD.md】
- Maintain tile cache integrity and avoid partial data responses; correctness outweighs completeness under upstream failure conditions.【docs/DECISION_LOG.md】
- Keep observability parity (logging and statistics endpoints) from the first usable release to avoid operational blind spots.【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md】

## 2. Step-by-Step Build Plan

### Phase 0 — Foundation & environment
- **Goal:** Establish build/runtime scaffolding and configuration contract.
- **Components to implement:** Configuration loader with documented defaults; basic HTTP server scaffold; dependency wiring boundaries.
- **Dependencies:** PRD and Technical Specification configuration section; decisions on compatibility and scope.【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Server starts on configured `PORT` and reads required env vars.
  - Configuration defaults match PRD/Spec values.
- **Exit criteria:** Config system matches PRD defaults; server can accept a health request (even if placeholder).
- **Common failure modes:** Mismatched defaults; missing env overrides; divergence from compatibility contract.

### Phase 1 — Query parsing & cacheability gate
- **Goal:** Implement interpreter request parsing and cacheability validation.
- **Components to implement:** Query extraction, JSON output detection, amenity filter detection, bbox parsing/validation.
- **Dependencies:** PRD functional requirements FR-001/FR-002; Spec data models for bbox parsing.【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Requests without query yield 400.
  - Non-JSON or non-amenity queries are routed to transparent proxy path.
  - Missing/invalid bbox yields 400.
- **Exit criteria:** Cacheability gate behaves identically to PRD and Spec.
- **Common failure modes:** Accepting unsupported query variants; incorrect bbox parsing; amenity detection mismatches.

### Phase 2 — Tiling & cache key model
- **Goal:** Implement geohash tiling and cache key scheme.
- **Components to implement:** Geohash tiling (`tilesForBoundingBox` equivalent), tile key format, bounds calculation.
- **Dependencies:** PRD FR-003/FR-004; Spec data models for TileInfo and tile key format.【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Tile count matches expected precision and bbox coverage.
  - Tile keys follow `tile:<amenity>:<geohash>` and are stable.
- **Exit criteria:** Deterministic tiling and key generation with validated bbox constraints.
- **Common failure modes:** Precision mismatch; incorrect bbox bounds for tiles; unstable keys.

### Phase 3 — Cache store & SWR mechanics
- **Goal:** Implement Redis-backed cache read/write with SWR and lock semantics.
- **Components to implement:** Read/write payloads, stale detection, refresh locks, miss locks, presence/coverage tracking.
- **Dependencies:** PRD FR-004/FR-005/FR-006; ADR-003/ADR-005; Spec store component details.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Reads return stale markers when TTL exceeded.
  - Writes persist payload metadata (`response`, `fetchedAt`, `expiresAt`).
  - Locks prevent duplicate refreshes and allow waiters to proceed on failures.
- **Exit criteria:** SWR semantics match PRD, including deferred refresh only when cache coverage is complete.
- **Common failure modes:** Stale served with missing tiles; lock leaks; incorrect TTL handling.

### Phase 4 — Upstream connector & retry behavior
- **Goal:** Implement upstream query construction, request execution, and retries.
- **Components to implement:** Canonical Overpass query builder, HTTP client with retries/backoff, upstream pool with cooldowns/daily limit.
- **Dependencies:** PRD FR-005/FR-009/FR-012; ADR-013/ADR-019; Spec upstream component rules.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Upstream POST payloads match canonical query structure.
  - Retry policy excludes 429 and respects configured limits.
  - Cooldown/daily limit state prevents selection of blocked upstreams.
- **Exit criteria:** Upstream fetches produce correct responses and respect pool state rules.
- **Common failure modes:** Retry storms on 429; not honoring daily limits; incorrect request headers.

### Phase 5 — Response assembly & conditional headers
- **Goal:** Merge tile responses with dedupe and bbox filtering; support ETags.
- **Components to implement:** Response assembler; ETag generator; conditional response handling.
- **Dependencies:** PRD FR-007/FR-008; ADR-007/ADR-008; Spec assembly/headers component rules.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Dedupe by `(type,id)` across tiles.
  - Filter to original bbox.
  - Matching `If-None-Match` yields 304.
- **Exit criteria:** Response assembly identical in semantics to existing behavior.
- **Common failure modes:** Duplicate elements; incorrect bbox filtering; unstable ETags.

### Phase 6 — Interpreter endpoint integration
- **Goal:** Combine parsing, caching, upstream fetch, assembly, and statistics recording into `/api/interpreter`.
- **Components to implement:** Full request lifecycle handler, cache headers, 413/503 error handling.
- **Dependencies:** PRD FR-001–FR-008; ADR-001–ADR-006; Spec core workflow definitions.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Cache hits do not call upstream.
  - Stale behavior matches configuration.
  - Missing tiles return 503 with cache headers.
- **Exit criteria:** Interpreter path matches PRD requirements and error semantics.
- **Common failure modes:** Serving partial data; missing cache headers; wrong error codes.

### Phase 7 — Transparent proxy endpoints
- **Goal:** Proxy non-cacheable endpoints and arbitrary `/api/*` requests.
- **Components to implement:** Pass-through handler preserving method/body/headers; upstream error mapping.
- **Dependencies:** PRD FR-009; ADR-009; Spec transparent proxy workflow rules.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Non-cacheable interpreter requests route upstream.
  - `/api/status`, `/api/timestamp`, `/api/kill_my_queries` forwarded.
  - Request/response headers and bodies are preserved across proxying for representative endpoints. (Reconstruction Assumption)
- **Exit criteria:** Transparent proxy parity with current behavior.
- **Common failure modes:** Header loss; incorrect method mapping; body encoding issues.

### Phase 8 — Statistics & dashboards
- **Goal:** Implement statistics aggregation, cache coverage snapshots, and endpoints; wire dashboards.
- **Components to implement:** Statistics tracker, Redis persistence, worker-based refresh, endpoints; static HTML serving.
- **Dependencies:** PRD FR-010; ADR-010/ADR-011; Spec stats subsystem details; cache presence restoration in store initialization.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Statistics endpoints return snapshots or 202 pending.
  - Coverage snapshots are bounded/compacted.
- **Exit criteria:** Stats endpoints align with existing payloads used by dashboards.
- **Common failure modes:** Unbounded payload growth; missing fields for dashboards.

### Phase 9 — Cache invalidation
- **Goal:** Implement secret-protected cache invalidation endpoint.
- **Components to implement:** Secret validation, bbox parsing, tile computation, deletion summary.
- **Dependencies:** PRD FR-011; ADR-012; Spec invalidation details.【docs/PRD.md, docs/DECISION_LOG.md, docs/TECHNICAL_SPECIFICATION.md】
- **Validation checkpoints:**
  - Missing secret yields 403.
  - Missing bbox yields 400.
  - Valid request returns deletion summary.
- **Exit criteria:** Invalidator behavior matches PRD and existing UI expectations.
- **Common failure modes:** Secret parsing mismatch; incorrect bbox parsing paths.

## 3. Test Strategy

- **Recreate first:** Unit tests for bbox parsing, tiling, headers, and assemble logic (core invariants). These define correctness and must match PRD/Spec data rules.【docs/TECHNICAL_SPECIFICATION.md, docs/PRD.md】
- **Second wave:** Store semantics tests (stale/locks), fetch plan grouping, and upstream tests for retry/cooldown behavior to ensure cache correctness and upstream safety.【docs/TECHNICAL_SPECIFICATION.md, docs/DECISION_LOG.md】
- **Integration tests:** Cache warm/hit cycles, stale refresh behavior, ETag handling, tile limit enforcement, and amenity separation. Use in-memory Redis + mock Overpass for baseline, Docker-based tests optional.【docs/PRD.md, docs/DECISION_LOG.md】
- **Gaps to fill:** Add explicit tests for cache invalidation endpoint and transparent proxy header/body fidelity if not already present. (Reconstruction Assumption)【docs/PRD.md】
- **Regression prevention:** Lock PRD/Spec behavior with tests that assert status codes, headers, and error messages for key paths (400/413/503/304).【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md】

## 4. Migration / Compatibility Notes (if applicable)
- Maintain exact endpoint paths and response status codes; clients should not require changes to switch to the new implementation.【docs/PRD.md】
- Preserve cache header semantics (`X-Cache`, `X-Cache-Fetched-At`) and ETag behavior for existing clients and tooling.【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md】
- Preserve stats endpoint payload shapes used by HTML dashboards. **Reconstruction Assumption:** dashboards are considered part of the compatibility surface.【docs/TECHNICAL_SPECIFICATION.md】

## 5. Extension Points

### Safe extension areas
- **Upstream routing enhancements:** Weighted selection and probing are planned and safe if they preserve existing error handling and daily limits.【docs/DECISION_LOG.md】
- **Additional cacheable query types:** Only after new ADRs and tests; must not violate current cacheability gate behavior without opt-in.【docs/DECISION_LOG.md, docs/PRD.md】
- **Observability enhancements:** Additional metrics or tracing can be added if statistics payloads remain backward compatible.【docs/PRD.md】

### Recommended abstractions
- **Upstream selection strategy interface** to swap random vs weighted selection while preserving pool constraints.【docs/DECISION_LOG.md】
- **Cache store interface** to allow Redis replacement or sharded implementations without changing interpreter logic.【docs/TECHNICAL_SPECIFICATION.md】
- **Statistics provider interface** to allow alternative storage/aggregation backends.【docs/TECHNICAL_SPECIFICATION.md】

## 6. Risk Map

### Danger zones
- **SWR logic correctness:** Serving stale data when cache is incomplete breaks data integrity and contradicts ADR-005/ADR-006.【docs/DECISION_LOG.md】
- **Transparent proxy parity:** Any deviation in request/response behavior can break client compatibility.【docs/PRD.md】
- **Cache invalidation security:** Incorrect secret handling exposes cache to unauthorized purges.【docs/PRD.md】

### Performance traps
- **Tile explosion:** Large bbox queries can exceed resource limits if tile budget enforcement is missing or misconfigured.【docs/PRD.md】
- **Unbounded coverage payloads:** Stats coverage without compaction can overwhelm dashboards and clients.【docs/TECHNICAL_SPECIFICATION.md】

### Security pitfalls
- **Permissive CORS:** Remains a deliberate decision; new deployments must validate whether open access is acceptable.【docs/DECISION_LOG.md】
- **Logging sensitive data:** Request body logging may capture sensitive parameters; review log redaction policy. (Reconstruction Assumption)【docs/DECISION_LOG.md】

## 7. Technical Debt Ledger

- **Planned upstream weighting/probing not implemented:** ADR-019 indicates planned improvements; schedule and validate once reimplementation parity is reached.【docs/DECISION_LOG.md】
- **CORS policy hardcoded permissive:** May require configurability; evaluate whether origin allowlists are needed for production security posture.【docs/DECISION_LOG.md】
- **Cache invalidation UI/backends coupling:** Ensure API response shapes remain stable if UI evolves; consider explicit versioning. (Reconstruction Assumption)【docs/PRD.md】
