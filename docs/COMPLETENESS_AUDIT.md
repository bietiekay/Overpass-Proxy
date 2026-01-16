# COMPLETENESS AUDIT

## 1. Audit Scope & Method
- **What was checked:** The audit cross-checked the generated documentation set (`docs/PROJECT_MAP_AND_EVIDENCE_INDEX.md`, `docs/INTENT_AND_PROBLEM_RECONSTRUCTION.md`, `docs/PRD.md`, `docs/TECHNICAL_SPECIFICATION.md`, `docs/DECISION_LOG.md`, `docs/REIMPLEMENTATION_ROADMAP_AND_EVOLUTION.md`) against repository sources including `specification.md`, `README.md`, all `src/*.ts` files, all tests under `src/tests/**`, and all `.specstory/history/*.md` entries.
- **How evidence was validated:** Each documented claim was mapped to concrete evidence (file paths, identifiers, or test cases). Coverage was judged by the presence of matching implementation details or tests and explicit mention in the specification or README.
- **Limitations:** The audit does not execute runtime behavior or validate external systems (e.g., upstream Overpass availability). Evidence is derived solely from repository artifacts and SpecStory logs.

## 2. Coverage Matrix (Docs ↔ Reality)

| Area / Topic | Expected Coverage (from PRD/SPEC) | Evidence Found (file paths + identifiers) | Coverage Status | Notes |
| --- | --- | --- | --- | --- |
| Request lifecycle (cacheable interpreter flow) | PRD FR-001–FR-008; Spec Section 3/4 | `src/interpreter.ts` (`registerInterpreterRoutes`, `handleCacheable`), `specification.md` (Request Classification Flow), `src/tests/integration/integration.test.ts` (cache warm/hit/stale) | Complete | Covered in PRD, Spec, and tests. |
| Transparent proxy behavior | PRD FR-009; Spec Section 5 | `src/interpreter.ts` (`proxyTransparent` paths), `src/upstream.ts` (`proxyTransparent`) | Complete | Tests for transparent proxy fidelity are not explicit; behavior inferred from code. |
| Cache invalidation | PRD FR-011; Spec Section 11 | `src/interpreter.ts` (`/api/cache/invalidate`), `README.md` (Cache invalidation tool/API) | Partial | No dedicated tests for invalidation endpoint found; PRD mentions acceptance criteria but no test evidence. |
| Statistics endpoints | PRD FR-010; Spec Section 11 | `src/interpreter.ts` (`/api/statistics*`), `src/stats.ts`, `src/tests/unit/stats.test.ts` | Complete | Coverage includes snapshot behavior and compaction. |
| Upstream routing and limits | PRD FR-012; Spec Section 12 | `src/upstream.ts` (`UpstreamPool`, retry/backoff), `.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md` | Partial | PRD treats weighted routing as planned; current code includes pool/limits but not the planned EWMA weighting. |
| Data models: BoundingBox/TileInfo | Spec Data Models; PRD core flows | `src/bbox.ts` (BoundingBox validation), `src/tiling.ts` (TileInfo), `src/tests/unit/bbox.test.ts`, `src/tests/unit/tiling.test.ts` | Complete | Documented and tested. |
| Cache payload schema | Spec Data Model; PRD Data Requirements | `src/store.ts` (payload `{ response, fetchedAt, expiresAt }`) | Complete | Tested for stale behavior and persistence. |
| Response assembly & ETag | PRD FR-007/FR-008 | `src/assemble.ts`, `src/headers.ts`, `src/tests/unit/assemble.test.ts`, `src/tests/unit/headers.test.ts` | Complete | Meets PRD acceptance criteria. |
| Error handling & edge cases | Spec Section 3/4; PRD error paths | `src/interpreter.ts` (400/413/503), `src/tests/unit/tiling.test.ts` (invalid bbox), `src/tests/unit/store.test.ts` (lock failure paths) | Partial | Explicit tests for 400/503 error payloads are limited; behavior inferred from code/spec. |
| Configuration & environment | Spec Section 7; README config table | `src/config.ts` (`loadConfig`), `README.md` (config table), `src/tests/unit/config.test.ts` | Complete | Config defaults and parsing are tested. |
| Security/privacy (cache invalidation, CORS, logging) | PRD Security; Spec notes | `src/interpreter.ts` (secret validation), `src/index.ts` (CORS), `.specstory/history/2025-10-28_14-28Z-cors-policy-blocking-api-access.md` | Partial | Privacy implications (IP logging) documented in Spec; no test evidence. |
| Performance constraints | Spec Tile budget/SWR; PRD NFRs | `src/interpreter.ts` (tile budget), `src/fetchPlan.ts` (grouping), `specification.md` (tile limits) | Complete | Evidence supports tile budget and grouping. |
| External integrations | Spec Section 9/12; PRD | `src/upstream.ts` (got), `src/store.ts` (ioredis), `package.json` dependencies | Complete | Evidence is present; no integration tests for real upstreams (expected). |

## 3. Requirements Traceability Audit

### PRD requirements lacking acceptance criteria
- **None found**: All FR entries in `docs/PRD.md` include acceptance criteria.

### PRD requirements lacking test evidence
- **FR-011 Cache invalidation** lacks test coverage: no tests in `src/tests/**` for `/api/cache/invalidate`. Evidence in code and README only. (`docs/PRD.md` FR-011; `src/interpreter.ts` `/api/cache/invalidate`; `README.md` cache invalidation section).
- **FR-009 Transparent proxy fidelity** lacks explicit tests for header/body preservation; only code evidence. (`docs/PRD.md` FR-009; `src/upstream.ts` `proxyTransparent`).
- **FR-006 SWR background refresh** is tested in integration but does not explicitly validate background refresh queue invocation. (`docs/PRD.md` FR-006; `src/interpreter.ts` `enqueueStaleRefreshTask`; `src/tests/integration/integration.test.ts`).

### Tests specifying behavior not captured in PRD
- **Stats compaction limits**: `src/tests/unit/stats.test.ts` verifies compaction of cache coverage and geohash coverage sizes, but PRD does not explicitly require compaction thresholds. Recommendation: add PRD non-functional requirement or data requirement for bounded coverage payloads. (`src/tests/unit/stats.test.ts` tests for compaction; `docs/PRD.md` NFR Observability).
- **Miss-lock waiter behavior**: `src/tests/unit/store.test.ts` verifies that waiters are notified immediately on handler failure. PRD does not mention lock behavior. Recommendation: document lock semantics in PRD or TECHNICAL_SPECIFICATION. (`src/tests/unit/store.test.ts` “notifies miss-lock waiters immediately”).

### Recommended updates
- Add explicit PRD requirement for cache invalidation tests or operational validation.
- Add PRD/NFR for bounded stats payload sizes and lock semantics if considered contractual.

## 4. Architecture Consistency Audit

### Contradictions between PRD and TECHNICAL_SPECIFICATION
- **None detected**: Technical Specification appears consistent with PRD on core flows, data models, and error handling.

### Mismatches between SPEC and code/tests
- **Spec mentions `RATE_LIMIT` utility is available but unused**; code confirms `TokenBucket` exists but not used. No mismatch.
- **Spec describes `UPSTREAM_URL` default and `UPSTREAM_URLS` usage**; config matches. No mismatch.
- **Spec references statistics endpoints and SWR behavior**; code aligns. No mismatch.
- **Potential ambiguity:** Spec notes that stale entries are served when `SERVE_STALE_FROM_CACHE=true` and cache fully covers request; code uses this guard. No mismatch.

## 5. Decision Log Integrity Audit

### Decisions claimed but not evidenced
- **ADR-019 Planned weighted routing**: decision is described as planned; evidence is from SpecStory plan doc rather than implemented code. Marked as “Accepted (Planned)” but could be recorded as “Proposed” or “Superseded-by future ADR”. Evidence: `.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md`; no implementation in `src/upstream.ts`.

### Evidenced decisions missing from DECISION_LOG
- **Logging bbox/Redis tile read/write** decision in `.specstory/history/2025-10-28_13-07Z-add-logging-for-request-handling-flow.md` is not explicitly listed as its own ADR. It appears partially covered under ADR-015 (logging) but not the bbox-specific logging. Recommendation: add ADR or sub-entry if required for completeness.

### Superseded decisions not marked
- **Compose changes** in SpecStory are decisions but are not marked superseded; no evidence they were later reversed. No action required unless a later decision contradicts them.

## 6. Roadmap Feasibility Audit

- **Steps lacking prerequisites:** Phase 8 (Statistics & dashboards) depends on Redis and Store presence/coverage logic; roadmap does not explicitly state dependency on cache presence restoration. Suggest adding a prerequisite note. (`docs/REIMPLEMENTATION_ROADMAP_AND_EVOLUTION.md` Phase 8; `src/store.ts` `restorePresence`).
- **Missing validation checkpoints:** Phase 7 (Transparent proxy endpoints) lacks checkpoint for header preservation fidelity. Suggest adding a checkpoint to compare request/response headers. (`docs/REIMPLEMENTATION_ROADMAP_AND_EVOLUTION.md` Phase 7; `src/upstream.ts` `proxyTransparent`).
- **Missing minimal viable intermediate states:** Phase 6 integrates stats; a minimal viable state could allow interpreter responses before stats endpoints. Roadmap does not explicitly define a “cache-only” MVP. Suggest clarifying. (`docs/REIMPLEMENTATION_ROADMAP_AND_EVOLUTION.md` Phase 6/8).

## 7. Gap List (Prioritized)

| Gap ID | Description | Severity | What file(s) should be updated | Evidence pointers |
| --- | --- | --- | --- | --- |
| GAP-001 | Add explicit tests (or test plan) for `/api/cache/invalidate` endpoint behavior. | High | `docs/PRD.md` (FR-011), test suite | `src/interpreter.ts` (`/api/cache/invalidate`), `README.md` cache invalidation section |
| GAP-002 | Document stats payload compaction limits as requirements to match tests. | Medium | `docs/PRD.md` NFR Observability or Data Requirements | `src/tests/unit/stats.test.ts` (compaction tests), `src/stats.ts` (compaction logic) |
| GAP-003 | Add lock/miss-waiter semantics to technical spec or PRD. | Medium | `docs/TECHNICAL_SPECIFICATION.md` (Store component) | `src/tests/unit/store.test.ts` (miss-lock waiter) |
| GAP-004 | Clarify decision status for planned upstream weighting/probes. | Low | `docs/DECISION_LOG.md` (ADR-019 status) | `.specstory/history/2025-12-05_10-33Z-upgrade-upstream-handling-with-new-features.md`, `src/upstream.ts` |
| GAP-005 | Add explicit roadmap checkpoint for proxy header/body fidelity validation. | Low | `docs/REIMPLEMENTATION_ROADMAP_AND_EVOLUTION.md` (Phase 7) | `src/upstream.ts` (`proxyTransparent`) |

## 8. Recommended Fix Plan

- [ ] **PRD:** Update FR-011 to add test evidence or a requirement to add tests for cache invalidation; reference `src/interpreter.ts` behavior. (`docs/PRD.md`, FR-011)
- [ ] **PRD/NFR:** Add bounded stats payload requirement to align with compaction logic tested in `src/tests/unit/stats.test.ts`. (`docs/PRD.md`, NFR Observability)
- [ ] **Technical Spec:** Expand Store component notes to include miss-lock waiter semantics and refresh-lock behavior. (`docs/TECHNICAL_SPECIFICATION.md`, Component 2.3)
- [ ] **Decision Log:** Adjust ADR-019 status to “Proposed/Planned” or add superseding ADR once implemented. (`docs/DECISION_LOG.md`, ADR-019)
- [ ] **Roadmap:** Add explicit validation checkpoint for transparent proxy header/body fidelity and prerequisite note for cache presence restoration before stats. (`docs/REIMPLEMENTATION_ROADMAP_AND_EVOLUTION.md`, Phases 7–8)
