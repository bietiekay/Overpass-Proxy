# TEST RATIONALE & SPECIFICATION

## 1. Purpose of the Test Suite
- **Role of tests in this project:** Tests act as executable specifications for core cacheability, tiling, caching, assembly, statistics, and upstream behaviors, and as regression guards for expected error handling and edge cases.【specification.md, docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md, src/tests/unit/*.test.ts, src/tests/integration/integration.test.ts】
- **Relationship between tests, PRD, and Technical Specification:** The PRD defines the contract, the Technical Specification defines component behavior, and tests validate those behaviors or expose underspecified requirements (e.g., cache coverage compaction).【docs/PRD.md, docs/TECHNICAL_SPECIFICATION.md, docs/COMPLETENESS_AUDIT.md, src/tests/unit/stats.test.ts】
- **Tests as executable specification vs regression safety net:** Unit tests specify deterministic behavior of parsing, tiling, assembly, and cache semantics; integration tests validate end-to-end cache flows and header behavior as regressions against real wiring.【src/tests/unit/*.test.ts, src/tests/integration/integration.test.ts】
- **Explicit non-goals of the test suite:** Tests do not validate live upstream Overpass availability or real network conditions; Docker-based integration tests are optional and are replaced by in-memory/mocked components when unavailable.【README.md, src/tests/integration/testcontainers.ts】

## 2. Test Taxonomy & Strategy
- **Test levels:**
  - **Unit tests:** Validate deterministic behavior of parsing, tiling, store semantics, headers, assembly, rate limiting, and stats aggregation. These tests isolate components from external systems.【src/tests/unit/*.test.ts】
  - **Integration tests:** Validate combined behavior of interpreter endpoints with cache warm/hit/stale flows and header handling using an in-process server and mock upstream/Redis; optionally run with Docker-backed Redis when available.【src/tests/integration/integration.test.ts, src/tests/integration/testcontainers.ts】
  - **E2E tests:** None present. E2E coverage is explicitly avoided due to environmental dependencies and cost. (Reconstruction Assumption)【README.md, src/tests/integration/testcontainers.ts】
- **Responsibilities by level:**
  - Unit tests ensure component invariants and edge cases; integration tests ensure inter-component wiring is correct (e.g., cache headers, stale refresh behavior).【docs/TECHNICAL_SPECIFICATION.md, src/tests/unit/*.test.ts, src/tests/integration/integration.test.ts】
- **Explicitly avoided:**
  - Live upstream behavior, performance benchmarking, and UI rendering correctness for dashboards are not covered by tests.【README.md, public/*.html】
- **Tradeoffs and rationale:**
  - Mocking is favored to keep test execution deterministic without Docker; this aligns with ADR-020 (non-Docker tests) and the testing strategy documented in README.【docs/DECISION_LOG.md, README.md, src/tests/integration/testcontainers.ts】
- **Mapping to architectural layers:**
  - Query parsing/tiling: `bbox.ts`, `tiling.ts`, `fetchPlan.ts` → unit tests.
  - Store/cache: `store.ts` → unit tests.
  - Upstream logic: `upstream.ts` → unit tests with mocked HTTP.
  - Interpreter routing and caching flow: `interpreter.ts` + `index.ts` → integration tests.
  - Statistics: `stats.ts` → unit tests.
  - Observability logging and CORS: verified by code and spec, not explicitly tested. (Reconstruction Assumption)【docs/TECHNICAL_SPECIFICATION.md, src/index.ts】

## 3. Global Testing Assumptions & Invariants
- **System invariants:**
  - Bbox coordinates must be finite and ordered (`south < north`, `west < east`).【src/bbox.ts, src/tests/unit/bbox.test.ts】
  - Tile hashes are deterministic for a bbox and precision, and are deduplicated to avoid duplicates in cache and stats.【src/tiling.ts, src/tests/unit/tiling.test.ts】
  - Assembled responses must be deduplicated by element `(type,id)` and filtered to the request bbox.【src/assemble.ts, src/tests/unit/assemble.test.ts】
- **Environmental assumptions:**
  - Integration tests can run without Docker using in-memory Redis and a mock Overpass server; Docker-backed integration tests are optional via `USE_DOCKER=1`.【README.md, src/tests/integration/testcontainers.ts】
- **Determinism vs variability:**
  - Unit tests are deterministic and should not rely on timing or external systems; any time-based behavior uses fake timers where needed (e.g., stale refresh queue).【src/tests/unit/staleRefreshQueue.test.ts】
  - Integration tests allow short timeouts to validate stale-refresh behavior; sleep durations are kept minimal.【src/tests/integration/integration.test.ts】
- **Mocking / faking philosophy:**
  - Upstream HTTP is mocked in unit tests to simulate error codes and retry behavior; integration tests use a mock Overpass server. This ensures deterministic behavior without reliance on external APIs.【src/tests/unit/upstream.test.ts, src/tests/integration/mock-overpass.ts】
- **Error-handling expectations:**
  - Errors are expected to map to defined status codes (400/413/503) in interpreter flows and should be tested at least at integration level; missing tests are flagged in completeness audit. (Reconstruction Assumption)【docs/COMPLETENESS_AUDIT.md, src/interpreter.ts】

## 4. Detailed Test Case Derivation (Core Section)

### 4.1 Query Parsing & Amenity/BBox Detection
#### Why this is tested
- Cacheability gate relies on correct detection of JSON output, amenity filter, and bbox extraction (PRD FR-002; ADR-002).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/bbox.test.ts】
#### What behavior is specified
- **Preconditions:** A query string representing Overpass QL.
- **Inputs:** Query strings with tuple bbox, directive bbox, comments, amenity filters, and output directives.
- **Expected outputs:** Correct bbox extraction or null for invalid tuples; correct detection of JSON output and amenity filter; amenity value extraction returns expected token.
- **Invariants enforced:** Bbox parsing ignores comments; malformed bbox returns null; JSON output detection is case-insensitive.【src/tests/unit/bbox.test.ts, src/bbox.ts】
#### Variants & Dimensions
- Tuple vs directive syntax; comments; malformed tuples; amenity filters with quotes/unquoted values; case insensitivity.
- **Not covered:** Non-amenity Overpass filters beyond `amenity`; reason: caching is scoped to amenity filters only (PRD FR-002).【docs/PRD.md】
#### How this is implemented in tests
- Unit tests provide multiple query strings and assert parsed outputs or null; amenity extraction tests verify trimming and quoting behaviors.【src/tests/unit/bbox.test.ts】
#### Relationship to Other Tests
- Feeds into integration tests that validate cacheable requests; no dependency ordering but these are foundational correctness tests.【src/tests/integration/integration.test.ts】

### 4.2 Geohash Tiling & Bounds
#### Why this is tested
- Tile computation determines cache keys and upstream fetch grouping (PRD FR-003/FR-004; ADR-003).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/tiling.test.ts】
#### What behavior is specified
- **Preconditions:** Valid bbox and geohash precision.
- **Inputs:** Bboxes of varying sizes; precision settings.
- **Expected outputs:** Tiles covering bbox, unique hashes, consistent precision lengths, and errors on invalid bbox.
- **Invariants enforced:** No duplicate tiles; precision is preserved to avoid mixing tiles across levels.【src/tests/unit/tiling.test.ts, src/tiling.ts】
#### Variants & Dimensions
- Small bbox (dedupe), coarse precision, invalid bbox (negative or inverted bounds).
- **Not covered:** Performance of large bbox tiling; reason: performance testing is out of scope for unit tests.【docs/PRD.md】
#### How this is implemented in tests
- Tests compute tiles and assert hash formats, uniqueness, and error throws for invalid input.【src/tests/unit/tiling.test.ts】
#### Relationship to Other Tests
- Supports cache and integration tests by ensuring tile generation is deterministic; no runtime dependency on integration tests.

### 4.3 Tile Fetch Planning (Grouping)
#### Why this is tested
- Upstream request grouping must not over-merge tiles or cross prefixes (PRD FR-005; ADR-003/ADR-013).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/fetchPlan.test.ts】
#### What behavior is specified
- **Preconditions:** A set of tile hashes at fine precision.
- **Inputs:** Tiles with same and different coarse prefixes, target tiles per request.
- **Expected outputs:** Tiles grouped by coarse prefix and area limits; different prefixes remain separate.
- **Invariants enforced:** Groups are stable and bounds encompass all tiles in the group.【src/tests/unit/fetchPlan.test.ts, src/fetchPlan.ts】
#### Variants & Dimensions
- Single tile, multiple tiles under same prefix, different prefixes, target size limits.
- **Not covered:** Extreme target size tuning; reason: grouping heuristics are fixed and validated by default behavior.【docs/TECHNICAL_SPECIFICATION.md】
#### How this is implemented in tests
- Tests assemble tile lists and validate grouping count, membership, and bounds relationships.【src/tests/unit/fetchPlan.test.ts】
#### Relationship to Other Tests
- Indirectly supports integration tests by ensuring upstream grouping is predictable.

### 4.4 Cache Store Semantics
#### Why this is tested
- Cache correctness depends on write/read, stale marking, persistence, and lock behavior (PRD FR-004/FR-005/FR-006; ADR-005).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/store.test.ts】
#### What behavior is specified
- **Preconditions:** Redis-like store (in-memory fake) and tile entries.
- **Inputs:** Writes of single/multiple tiles, TTL parameters, locks.
- **Expected outputs:** Readable cached responses, stale flags after TTL, persistent keys, and correct behavior of locks and waiters.
- **Invariants enforced:** Stale entries remain in Redis; lock tokens are not incorrectly removed; miss-lock waiters proceed on failures.【src/tests/unit/store.test.ts, src/store.ts】
#### Variants & Dimensions
- Negative TTL for forced stale, multi-tile pipeline writes, presence restoration, lock token changes, miss-lock failure behavior.
- **Not covered:** Redis network failure handling; reason: unit tests use in-memory Redis and avoid network behaviors.【README.md】
#### How this is implemented in tests
- Uses in-memory Redis; asserts cached values, TTL behavior, counts, and lock semantics; uses fake timers where needed.【src/tests/unit/store.test.ts】
#### Relationship to Other Tests
- Supports integration tests by ensuring cache store is deterministic and resilient to lock edge cases.

### 4.5 Response Assembly & Bbox Filtering
#### Why this is tested
- Correctness requires deduplication and bounding of response elements (PRD FR-007; ADR-007).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/assemble.test.ts】
#### What behavior is specified
- **Preconditions:** Multiple Overpass responses with overlapping elements.
- **Inputs:** Sample responses with nodes/ways/relations; bbox constraints.
- **Expected outputs:** Deduplicated elements, filtered to bbox, cloned objects to avoid mutation.
- **Invariants enforced:** Elements outside bbox are excluded; duplicates removed by `(type,id)` key.【src/tests/unit/assemble.test.ts, src/assemble.ts】
#### Variants & Dimensions
- Full bbox vs subset bbox; duplication across responses; membership relationships (ways/relations).
- **Not covered:** Extremely large element sets; reason: unit tests focus on correctness not performance.
#### How this is implemented in tests
- Tests construct sample elements and assert length, IDs, and clone behavior (not identity).【src/tests/unit/assemble.test.ts】
#### Relationship to Other Tests
- Integration tests rely on assembler correctness indirectly; no direct dependency ordering.

### 4.6 Conditional Headers (ETag)
#### Why this is tested
- ETag behavior enables conditional responses and bandwidth savings (PRD FR-008; ADR-008).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/headers.test.ts】
#### What behavior is specified
- **Preconditions:** Payload with deterministic JSON serialization.
- **Inputs:** Payloads and `If-None-Match` headers.
- **Expected outputs:** Stable weak ETag, 304 response when ETag matches.
- **Invariants enforced:** ETag remains stable for same payload; non-matching headers do not short-circuit response.【src/tests/unit/headers.test.ts, src/headers.ts】
#### Variants & Dimensions
- Matching vs non-matching ETag; header case handling.
- **Not covered:** ETag behavior across different serialization orders; reason: payloads are JSON-stringified consistently in code.【src/headers.ts】
#### How this is implemented in tests
- Unit tests call ETag generation and applyConditionalHeaders on a mock reply object.【src/tests/unit/headers.test.ts】
#### Relationship to Other Tests
- Integration tests validate ETag handling for interpreter responses (header presence).【src/tests/integration/integration.test.ts】

### 4.7 Logging Configuration & Progress Logging
#### Why this is tested
- Logging behavior must map environment verbosity settings and support progress logging (ADR-015).【docs/DECISION_LOG.md, src/tests/unit/logger.test.ts】
#### What behavior is specified
- **Preconditions:** Environment variables for verbosity.
- **Inputs:** LOG_VERBOSITY/LOG_LEVEL combinations and loggers with different levels.
- **Expected outputs:** Correct log level resolution and progress logs; silent logging when configured.
- **Invariants enforced:** Test environment defaults to silent; progress logging emits percentages correctly.【src/tests/unit/logger.test.ts, src/logger.ts】
#### Variants & Dimensions
- Verbosity values, fallback to LOG_LEVEL, silent behavior.
- **Not covered:** Full request logging content; reason: request logging is integration-level behavior without explicit tests (not in unit tests). (Reconstruction Assumption)
#### How this is implemented in tests
- Uses pino streams and captures JSON logs for assertions.【src/tests/unit/logger.test.ts】
#### Relationship to Other Tests
- Complements integration request logging but does not depend on it.

### 4.8 Token Bucket Rate Limiter (Utility)
#### Why this is tested
- TokenBucket is a planned utility and must behave as documented even if not wired into request flow (PRD non-goal; Spec mentions future use).【docs/PRD.md, specification.md, src/tests/unit/rateLimit.test.ts】
#### What behavior is specified
- **Preconditions:** Token bucket with capacity/refill rate.
- **Inputs:** Multiple `tryRemove` calls and time delays.
- **Expected outputs:** Immediate exhaustion after capacity; refill behavior over time.
- **Invariants enforced:** Tokens never exceed capacity; refills are time-based.【src/tests/unit/rateLimit.test.ts, src/rateLimit.ts】
#### Variants & Dimensions
- Small capacity, rapid refill.
- **Not covered:** Integration with request flow; reason: feature is not active. (Reconstruction Assumption)
#### How this is implemented in tests
- Tests remove tokens and use time delays to confirm refill behavior.【src/tests/unit/rateLimit.test.ts】
#### Relationship to Other Tests
- No dependencies; serves as utility correctness proof.

### 4.9 Statistics Aggregation & Coverage Compaction
#### Why this is tested
- Statistics drive operational dashboards; correctness and bounded payloads are required (PRD Observability; ADR-010/ADR-011).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/stats.test.ts】
#### What behavior is specified
- **Preconditions:** RequestStatistics initialized with cached tile counters and optional queue provider.
- **Inputs:** Recorded requests with different amenities, cache statuses, and timestamps; coverage snapshots.
- **Expected outputs:** Correct totals, hit rates, per-amenity stats, coverage snapshots, compaction when too large, and persistence across restarts.
- **Invariants enforced:** Coverage compaction preserves counts; snapshots omit cache coverage by default; daily/weekly/monthly counters reset appropriately.【src/tests/unit/stats.test.ts, src/stats.ts】
#### Variants & Dimensions
- Multiple amenities; different cache statuses; day/week/month boundaries; compaction thresholds.
- **Not covered:** Worker-thread transport correctness; reason: worker behavior is covered by code paths but not unit-tested. (Reconstruction Assumption)
#### How this is implemented in tests
- Uses an in-memory storage stub and deterministic timestamps; asserts snapshot fields and compaction results.【src/tests/unit/stats.test.ts】
#### Relationship to Other Tests
- Integration tests cover stats endpoints indirectly through interpreter behavior; no dependency ordering.

### 4.10 Stale Refresh Queue Behavior
#### Why this is tested
- Background stale refresh must not stall the queue and must recover from timeouts (ADR-005).【docs/DECISION_LOG.md, src/tests/unit/staleRefreshQueue.test.ts】
#### What behavior is specified
- **Preconditions:** Queue configured with timeout.
- **Inputs:** A hanging task followed by a completing task.
- **Expected outputs:** Queue proceeds to subsequent tasks after timeout; queue state reflects completion.
- **Invariants enforced:** Timeouts do not permanently block queue; metrics reflect queue state.【src/tests/unit/staleRefreshQueue.test.ts, src/staleRefreshQueue.ts】
#### Variants & Dimensions
- Timeout behavior; sequential queue operations.
- **Not covered:** Multi-amenity merge behavior; reason: core timeout behavior is prioritized. (Reconstruction Assumption)
#### How this is implemented in tests
- Uses fake timers to advance time and assert completion ordering and queue metrics.【src/tests/unit/staleRefreshQueue.test.ts】
#### Relationship to Other Tests
- Complements statistics tests when queue metrics are included; no direct dependencies.

### 4.11 Upstream HTTP Behavior & Failover
#### Why this is tested
- Upstream correctness and failover are critical for availability (PRD FR-005/FR-012; ADR-013).【docs/PRD.md, docs/DECISION_LOG.md, src/tests/unit/upstream.test.ts】
#### What behavior is specified
- **Preconditions:** Multiple upstream URLs and mocked HTTP client responses.
- **Inputs:** Success responses, 4xx errors, 5xx errors, and network errors.
- **Expected outputs:** Retry logic avoids 429; 400 errors do not mark upstream failed; failover to alternate upstreams occurs with cooldown enforcement.
- **Invariants enforced:** Client errors are not treated as upstream failures; backoff uses jitter and respects cooldown windows.【src/tests/unit/upstream.test.ts, src/upstream.ts】
#### Variants & Dimensions
- Different error codes; latency weighting not implemented; deterministic random behavior using spies.
- **Not covered:** Planned EWMA weighting/probing; reason: feature is planned but not implemented. (Reconstruction Assumption)【docs/DECISION_LOG.md】
#### How this is implemented in tests
- Mocks `got` and simulates failures/success; asserts call order and outcomes.【src/tests/unit/upstream.test.ts】
#### Relationship to Other Tests
- Supports integration tests by ensuring upstream fetching behavior is predictable.

### 4.12 Integration: Interpreter Cache Flow
#### Why this is tested
- End-to-end cache behavior validates the primary workflow (PRD FR-001–FR-008).【docs/PRD.md, src/tests/integration/integration.test.ts】
#### What behavior is specified
- **Preconditions:** Running server with Redis (mock or Docker) and mock Overpass.
- **Inputs:** POST interpreter requests with amenity/bbox, repeated calls, stale window behavior.
- **Expected outputs:** Cache hits after first call; `X-Cache-Fetched-At` header set; stale refresh behavior obeys config; amenity caches are separated.
- **Invariants enforced:** Cache hits do not trigger upstream hits; fetched-at times are non-decreasing; amenity segmentation maintained.【src/tests/integration/integration.test.ts】
#### Variants & Dimensions
- Different amenities; uppercase amenity normalization; stale refresh with `SERVE_STALE_FROM_CACHE=false`.
- **Not covered:** Cache invalidation flow and transparent proxy fidelity; reason: missing tests noted in completeness audit. (Reconstruction Assumption)【docs/COMPLETENESS_AUDIT.md】
#### How this is implemented in tests
- Uses in-process server created by `buildServer`, mock Overpass, and in-memory Redis; asserts upstream hit counts and headers.【src/tests/integration/integration.test.ts, src/tests/integration/mock-overpass.ts】
#### Relationship to Other Tests
- Builds on unit tests by validating combined behavior; no strict ordering required.

## 5. Negative Space: What Is Intentionally Not Tested
- **Cache invalidation endpoint behavior** is not covered by tests yet; this is an explicit gap identified in the completeness audit and treated as a reconstruction assumption in PRD.【docs/COMPLETENESS_AUDIT.md, docs/PRD.md】
- **Transparent proxy header/body fidelity** is not explicitly verified by tests; assumed to be correct based on implementation and should be added as future coverage.【docs/COMPLETENESS_AUDIT.md, src/upstream.ts】
- **Dashboard UI behavior** is not tested; HTML tools are operational utilities and not part of the automated test suite (no frontend test harness).【public/*.html, README.md】
- **Live upstream behavior** is not tested; upstream is mocked to maintain deterministic tests and avoid reliance on external networks.【src/tests/unit/upstream.test.ts, src/tests/integration/mock-overpass.ts】

## 6. Traceability Matrix (Tests ↔ Design)

| Test group / capability | PRD requirement(s) | Technical Spec section(s) | Decision Log entry | Test file(s) |
| --- | --- | --- | --- | --- |
| Query parsing & amenity/bbox detection | FR-002 | 2.7, 3.1 | ADR-002 | `src/tests/unit/bbox.test.ts` |
| Geohash tiling & bounds | FR-003/FR-004 | 2.7, 3.2 | ADR-003 | `src/tests/unit/tiling.test.ts` |
| Tile fetch planning | FR-005 | 2.7 | ADR-003 | `src/tests/unit/fetchPlan.test.ts` |
| Cache store semantics | FR-004/FR-005/FR-006 | 2.3 | ADR-005 | `src/tests/unit/store.test.ts` |
| Response assembly | FR-007 | 2.8 | ADR-007 | `src/tests/unit/assemble.test.ts` |
| ETag handling | FR-008 | 2.8 | ADR-008 | `src/tests/unit/headers.test.ts` |
| Logger configuration | NFR Observability | 2.1 | ADR-015 | `src/tests/unit/logger.test.ts` |
| Token bucket utility | Non-goal (future) | 2.0 (utility) | ADR-013 (supporting) | `src/tests/unit/rateLimit.test.ts` |
| Stats aggregation & compaction | FR-010, NFR Observability | 2.5, 3.5 | ADR-010/ADR-011 | `src/tests/unit/stats.test.ts` |
| Stale refresh queue | FR-006 | 2.6 | ADR-005 | `src/tests/unit/staleRefreshQueue.test.ts` |
| Upstream failover/retry | FR-005/FR-012 | 2.4 | ADR-013 | `src/tests/unit/upstream.test.ts` |
| Integration cache flow | FR-001–FR-008 | 4.1 | ADR-001–ADR-006 | `src/tests/integration/integration.test.ts` |
| Test environment selection | NFR Testability | 1.0 | ADR-020 | `src/tests/integration/testcontainers.ts` |

**Tests defining behavior not documented elsewhere:**
- Cache coverage compaction size limits are primarily defined by `src/tests/unit/stats.test.ts` and `src/stats.ts`; PRD now references bounded payloads but does not specify exact thresholds (Reconstruction Assumption).【docs/PRD.md, src/tests/unit/stats.test.ts】
- Miss-lock waiter behavior is defined in `src/tests/unit/store.test.ts` and captured in the Technical Specification store component section.【docs/TECHNICAL_SPECIFICATION.md, src/tests/unit/store.test.ts】

**Requirements relying solely on tests as specification:**
- None explicitly; all PRD requirements have at least spec or code references, though some behaviors are best evidenced by tests (e.g., stats compaction).【docs/PRD.md, docs/COMPLETENESS_AUDIT.md】

## 7. Stretch Goals: Additional Testable Aspects

### Additional edge cases
- **Cache invalidation endpoint tests** (unit/integration): validate secret parsing, bbox input variants, and tile count limits; mitigates operational risk. Not implemented due to prioritization of core cache flow.【docs/COMPLETENESS_AUDIT.md】
- **Transparent proxy header/body fidelity tests** (integration): assert exact header preservation and body streaming for `/api/*` endpoints; mitigates compatibility risk. Not implemented yet due to test harness scope.【docs/COMPLETENESS_AUDIT.md】

### Performance or stress scenarios
- **Large bbox tiling stress** (integration): validate performance and memory behavior when tile counts approach limits; mitigates tile explosion risk. Not implemented due to resource constraints in CI. (Reconstruction Assumption)

### Fault injection
- **Redis outage simulation** (integration): verify error responses and logging when Redis is unavailable; mitigates availability risk. Not implemented due to test environment complexity. (Reconstruction Assumption)

### Security / misuse cases
- **Cache invalidation brute-force attempts** (integration): ensure 403 responses and no side effects; not implemented due to lack of security test harness. (Reconstruction Assumption)

### Configuration matrix expansion
- **SWR on/off matrix** (integration): validate behavior when `SERVE_STALE_FROM_CACHE` toggles; partial coverage exists but not exhaustive. (Reconstruction Assumption)【src/tests/integration/integration.test.ts】

### Migration / upgrade scenarios
- **Stats persistence across restarts** (integration): validate Redis persistence with worker restart; not implemented due to worker orchestration complexity. (Reconstruction Assumption)

### Long-running or stateful behavior
- **Stale refresh queue backpressure** (unit/integration): validate queue metrics and throughput under load; not implemented. (Reconstruction Assumption)

## 8. Test Evolution Guidelines
- **Adding new tests:** Tie each new test to a PRD requirement or ADR and document the rationale in commit messages or accompanying docs to preserve traceability.【docs/PRD.md, docs/DECISION_LOG.md】
- **Refactor vs extend:** Refactor test helpers when multiple tests repeat setup for interpreter server or mock upstream; extend only when behavior is new or reinterpreted by ADR updates.【src/tests/integration/integration.test.ts, src/tests/integration/mock-overpass.ts】
- **Avoid over-specification:** Do not lock in incidental implementation details (e.g., log message formatting) unless required by PRD or ADR; focus on observable behavior and error codes.【docs/PRD.md, docs/DECISION_LOG.md】
- **Detect redundant/obsolete tests:** Reassess tests when ADRs are superseded or when PRD requirements are removed; keep tests aligned with the contract of record.【docs/DECISION_LOG.md, docs/PRD.md】
