---
name: Add Missing Test Cases
overview: Add comprehensive test coverage for cache invalidation endpoint, transparent proxy fidelity, error handling edge cases, and GET request handling based on gaps identified in the completeness audit and test specification documentation.
todos: []
---

# Test Coverage Enhancement Plan

## Overview

This plan addresses missing test cases identified in `docs/COMPLETENESS_AUDIT.md` and `docs/TEST_RATIONALE_AND_SPECIFICATION.md`. The gaps include cache invalidation endpoint tests (GAP-001), transparent proxy fidelity tests, error handling edge cases, and GET request handling.

## Test Cases to Implement

### 1. Cache Invalidation Endpoint Tests (`/api/cache/invalidate`)

**Location:** `src/tests/integration/integration.test.ts` (new describe block)

**Test Cases:**

1. **Secret validation - missing secret** (403)

- POST without `CACHE_INVALIDATION_SECRET` configured
- Expected: 403 with "Cache invalidation secret is not configured"

2. **Secret validation - wrong secret** (403)

- POST with incorrect secret value
- Expected: 403 with "Invalid secret keyword"

3. **Secret validation - missing secret parameter** (403)

- POST without secret in query/body
- Expected: 403 with "Invalid secret keyword"

4. **Bbox validation - missing bbox** (400)

- POST with valid secret but no bbox
- Expected: 400 with "Bounding box required"

5. **Bbox parsing - query string format** (200)

- POST with bbox as comma-separated string in query: `?bbox=52.5,13.3,52.6,13.4`
- Expected: Successful invalidation

6. **Bbox parsing - query string separate fields** (200)

- POST with bbox as separate query params: `?south=52.5&west=13.3&north=52.6&east=13.4`
- Expected: Successful invalidation

7. **Bbox parsing - JSON body format** (200)

- POST with bbox in JSON body: `{ "bbox": "52.5,13.3,52.6,13.4" }`
- Expected: Successful invalidation

8. **Bbox parsing - JSON body object** (200)

- POST with bbox as object: `{ "south": 52.5, "west": 13.3, "north": 52.6, "east": 13.4 }`
- Expected: Successful invalidation

9. **Bbox parsing - JSON body array** (200)

- POST with bbox as array: `{ "bbox": [52.5, 13.3, 52.6, 13.4] }`
- Expected: Successful invalidation

10. **Tile count limit enforcement** (413)

- POST with bbox that exceeds `MAX_TILES_PER_REQUEST`
- Expected: 413 with error message including tile count

11. **Successful invalidation - deletion summary** (200)

- POST with valid secret and bbox, verify tiles are deleted
- Expected: 200 with `{ ok: true, bbox, tileCount, deletedKeys, amenities }`

12. **Secret extraction - query parameter** (200)

- POST with secret in query: `?secret=test-secret`
- Expected: Successful invalidation

13. **Secret extraction - JSON body** (200)

- POST with secret in body: `{ "secret": "test-secret" }`
- Expected: Successful invalidation

**Reference:** `src/interpreter.ts:628-664`, `docs/PRD.md:FR-011`, `docs/COMPLETENESS_AUDIT.md:GAP-001`

### 2. Transparent Proxy Fidelity Tests

**Location:** `src/tests/integration/integration.test.ts` (new describe block)

**Test Cases:**

1. **Header preservation - custom headers**

- POST to `/api/status` with custom headers
- Expected: Headers forwarded to upstream (except host)

2. **Body preservation - POST body**

- POST to `/api/interpreter` (non-cacheable) with body
- Expected: Body forwarded unchanged to upstream

3. **Method preservation - GET request**

- GET to `/api/timestamp`
- Expected: GET forwarded to upstream

4. **Method preservation - POST request**

- POST to `/api/kill_my_queries`
- Expected: POST forwarded to upstream

5. **Response forwarding - status code**

- Upstream returns 200/404/500
- Expected: Same status code returned to client

6. **Response forwarding - response body**

- Upstream returns JSON/XML/text
- Expected: Same body returned to client

7. **Response forwarding - response headers**

- Upstream returns custom headers
- Expected: Headers forwarded to client (except connection-related)

8. **GET to interpreter - query string conversion**

- GET `/api/interpreter?data=...` (non-cacheable)
- Expected: Converted to POST with form body upstream

**Reference:** `src/upstream.ts:802-1012`, `docs/COMPLETENESS_AUDIT.md`, `docs/TEST_RATIONALE_AND_SPECIFICATION.md:272`

### 3. Error Handling Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (extend existing tests)

**Test Cases:**

1. **400 - Missing query payload (GET)**

- GET `/api/interpreter` without `data` or `q` parameter
- Expected: 400 with "Query payload required"

2. **400 - Missing query payload (POST)**

- POST `/api/interpreter` with empty body
- Expected: 400 with "Query payload required"

3. **400 - Missing bbox in cacheable query**

- POST with JSON output and amenity but no bbox
- Expected: 400 with "Bounding box required"

4. **503 - Unresolved tiles after upstream failure**

- Request with missing tiles, upstream fails
- Expected: 503 with "Requested area unavailable from cache" and X-Cache header

5. **503 - Partial cache coverage with upstream failure**

- Request with some cached tiles, some missing, upstream fails
- Expected: 503 with STALE cache header

6. **Error payload format validation**

- Verify all error responses have `{ error: string }` format
- Expected: Consistent error payload structure

**Reference:** `src/interpreter.ts:518-543`, `docs/TECHNICAL_SPECIFICATION.md:4.4`

### 4. GET Request Handling for Interpreter

**Location:** `src/tests/integration/integration.test.ts` (new test cases)

**Test Cases:**

1. **GET with data parameter - cacheable query**

- GET `/api/interpreter?data=[out:json];node["amenity"="toilets"](52.5,13.3,52.6,13.4);out;`
- Expected: 200, cached and served

2. **GET with q parameter - cacheable query**

- GET `/api/interpreter?q=[out:json];node["amenity"="toilets"](52.5,13.3,52.6,13.4);out;`
- Expected: 200, cached and served

3. **GET with data parameter - non-cacheable query**

- GET `/api/interpreter?data=[out:xml];node(1,1,2,2);out;`
- Expected: 200, proxied upstream

**Reference:** `src/interpreter.ts:166-197`, `docs/PRD.md:FR-001`

### 5. Statistics Endpoint Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (extend existing tests)

**Test Cases:**

1. **Cache coverage area - invalid precision**

- GET `/api/statistics/cacheCoverage/area?bbox=...&precision=invalid`
- Expected: 400

2. **Cache coverage area - precision out of range**

- GET with precision < 3 or > maxPrecision
- Expected: 400 or clamped to valid range

**Reference:** `src/interpreter.ts:587-626`

## Implementation Strategy

1. **Create test helper functions** for cache invalidation setup (secret config, bbox formats)
2. **Extend mock upstream** to support transparent proxy testing scenarios
3. **Add test fixtures** for various bbox and secret input formats
4. **Organize tests** in logical describe blocks within integration.test.ts
5. **Follow existing patterns** from current integration tests (setup, teardown, assertions)

## Files to Modify

- `src/tests/integration/integration.test.ts` - Add all new test cases
- Potentially extend `src/tests/integration/mock-overpass.ts` if needed for transparent proxy testing

## Success Criteria

- All test cases pass
- Coverage for cache invalidation endpoint matches PRD FR-011 acceptance criteria
- Transparent proxy behavior verified for header/body/method preservation
- Error handling paths explicitly tested with correct status codes and payloads
- GET request handling validated for both cacheable and non-cacheable queries