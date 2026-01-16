---
name: Additional Test Cases Enhancement
overview: Add comprehensive test coverage for upstream retry scenarios, daily limits, amenity extraction edge cases, ETag edge cases, concurrent requests, invalid input handling, and statistics pending states based on gaps identified in the codebase analysis.
todos: []
---

# Additional Test Cases Enhancement Plan

## Overview

This plan identifies additional test cases that could enhance coverage beyond the current 58 passing tests. The analysis reveals gaps in upstream retry behavior, daily limits, edge case handling, and concurrent request scenarios.

## Additional Test Cases to Implement

### 1. Upstream Retry & Error Handling Integration Tests

**Location:** `src/tests/integration/integration.test.ts` (new describe block: "upstream retry behavior")

**Test Cases:**

1. **Retries on 503 upstream error**

- Upstream returns 503, verify retry to next upstream
- Expected: Request succeeds after retry or fails after all upstreams exhausted

2. **Retries on 502 upstream error**

- Upstream returns 502, verify retry behavior
- Expected: Retry to next upstream

3. **Retries on 500 upstream error**

- Upstream returns 500, verify retry behavior
- Expected: Retry to next upstream

4. **Does not retry on 429 rate limit**

- Upstream returns 429
- Expected: No retry, immediate failover to next upstream (if available)

5. **Does not retry on 400 client error**

- Upstream returns 400
- Expected: No retry, error propagated immediately

6. **Retries on network errors (ECONNREFUSED, ETIMEDOUT)**

- Simulate network errors
- Expected: Retry to next upstream

7. **Respects upstream cooldown after failure**

- First upstream fails, verify cooldown period
- Expected: Second request uses different upstream during cooldown

8. **Daily limit enforcement blocks upstream**

- Configure daily limit, make requests exceeding limit
- Expected: Upstream blocked after limit, failover to next upstream

9. **All upstreams exhausted by daily limits**

- All upstreams hit daily limits
- Expected: 503 error with appropriate message

**Reference:** `src/upstream.ts:27-68`, `src/upstream.ts:429-503`, `docs/TECHNICAL_SPECIFICATION.md:2.4`

### 2. Amenity Extraction Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (new describe block: "amenity extraction")

**Test Cases:**

1. **Extracts amenity from query parameter (GET)**

- GET `/api/interpreter?data=...&amenity=drinking_water`
- Expected: Uses amenity from query param, not query body

2. **Extracts amenity from form body parameter**

- POST with `amenity=drinking_water` in form body
- Expected: Uses amenity from form body

3. **Falls back to default amenity when not found**

- Query without amenity filter and no amenity param
- Expected: Uses default 'toilets'

4. **Normalizes amenity from query parameter**

- GET with `amenity=TOILETS` (uppercase)
- Expected: Normalized to lowercase 'toilets'

5. **Handles amenity with whitespace**

- Query param `amenity=  drinking_water  ` (with spaces)
- Expected: Trims whitespace

6. **Prefers query body amenity over query param**

- Both query param and query body have amenity
- Expected: Uses query body amenity (query body parsed first)

**Reference:** `src/interpreter.ts:199-257`, `docs/TECHNICAL_SPECIFICATION.md:2.7`

### 3. ETag & Conditional Headers Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (extend existing ETag test)

**Test Cases:**

1. **ETag changes when response content changes**

- Make request, cache data, modify upstream response
- Expected: Different ETag on second request

2. **Handles multiple If-None-Match values**

- Request with `If-None-Match: "tag1", "tag2", W/"actual-etag"`
- Expected: 304 if actual ETag matches any value

3. **Case-insensitive If-None-Match header**

- Request with `if-none-match` (lowercase)
- Expected: 304 if ETag matches

4. **ETag format is weak ETag (W/")**

- Verify generated ETag starts with `W/"`
- Expected: Weak ETag format

5. **ETag remains stable for identical responses**

- Two identical requests
- Expected: Same ETag value

**Reference:** `src/headers.ts`, `docs/TECHNICAL_SPECIFICATION.md:2.8`, `docs/DECISION_LOG.md:ADR-008`

### 4. Cache Invalidation Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (extend cache invalidation describe block)

**Test Cases:**

1. **Handles invalidation with no matching tiles**

- Invalidate bbox with no cached tiles
- Expected: 200 with `deletedKeys: 0`, `tileCount: 0`

2. **Handles invalid bbox format (non-numeric)**

- POST with `bbox=invalid,values,here,test`
- Expected: 400 with "Bounding box required"

3. **Handles bbox with whitespace**

- POST with `bbox=52.5 , 13.3 , 52.6 , 13.4` (spaces)
- Expected: Parses correctly, successful invalidation

4. **Handles inverted bbox (south > north)**

- POST with invalid bbox where south > north
- Expected: 400 with "Bounding box required"

5. **Handles bbox at boundary values**

- POST with bbox at -180, 180, -90, 90
- Expected: Successful parsing and invalidation

6. **Handles empty bbox array**

- POST with `bbox=[]`
- Expected: 400 with "Bounding box required"

**Reference:** `src/interpreter.ts:75-112`, `src/interpreter.ts:628-664`

### 5. Concurrent Request Scenarios

**Location:** `src/tests/integration/integration.test.ts` (new describe block: "concurrent requests")

**Test Cases:**

1. **Multiple concurrent requests for same tiles (cache miss)**

- Send 3 simultaneous requests for same uncached query
- Expected: Only one upstream request, all 3 requests succeed

2. **Multiple concurrent requests for same tiles (cache hit)**

- Cache data, send 3 simultaneous requests
- Expected: All 3 return cached data, no upstream requests

3. **Concurrent requests for different amenities**

- Simultaneous requests for toilets and drinking_water
- Expected: Both cached separately, both succeed

4. **Concurrent invalidation and read**

- One request invalidates, another reads same tiles
- Expected: Read may get stale or fresh data, no errors

**Reference:** `src/store.ts` (lock mechanisms), `docs/TECHNICAL_SPECIFICATION.md:2.3`

### 6. Statistics Endpoint Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (extend statistics edge cases)

**Test Cases:**

1. **Returns 202 when statistics are pending**

- Request statistics immediately after server start
- Expected: 202 with `{ pending: true }`

2. **Cache coverage area with maxEntries parameter**

- GET with `maxEntries=10`
- Expected: Coverage limited to 10 entries

3. **Statistics with no requests yet**

- Request statistics before any interpreter requests
- Expected: Valid statistics object with zeros/empty arrays

4. **Geohash coverage pending state**

- Request geohash coverage immediately
- Expected: 202 if pending, 200 if ready

**Reference:** `src/interpreter.ts:547-626`, `docs/TECHNICAL_SPECIFICATION.md:2.5`

### 7. Invalid Input & Malformed Query Handling

**Location:** `src/tests/integration/integration.test.ts` (new describe block: "invalid input handling")

**Test Cases:**

1. **Handles malformed Overpass query syntax**

- POST with invalid Overpass QL syntax
- Expected: Proxied upstream (non-cacheable), upstream handles error

2. **Handles query with invalid bbox coordinates (NaN, Infinity)**

- POST with bbox containing NaN or Infinity
- Expected: 400 or proxied upstream with error

3. **Handles extremely large bbox values**

- POST with bbox values > 180 or < -180
- Expected: 400 or handled appropriately

4. **Handles empty query string**

- POST with empty `data` parameter
- Expected: 400 or proxied upstream

5. **Handles query with special characters in amenity**

- POST with amenity containing quotes, special chars
- Expected: Handled correctly or error

**Reference:** `src/bbox.ts`, `src/interpreter.ts:517-528`

### 8. Transparent Proxy Additional Scenarios

**Location:** `src/tests/integration/integration.test.ts` (extend transparent proxy describe block)

**Test Cases:**

1. **Preserves request method for PUT/DELETE**

- PUT/DELETE to `/api/*` endpoint
- Expected: Method preserved upstream

2. **Handles OPTIONS preflight requests**

- OPTIONS request to `/api/*`
- Expected: Proxied or handled by CORS

3. **Preserves query string for non-interpreter endpoints**

- GET `/api/status?param=value`
- Expected: Query string forwarded

4. **Handles large request bodies**

- POST with large body to transparent endpoint
- Expected: Body forwarded correctly

**Reference:** `src/upstream.ts:802-1012`, `docs/TECHNICAL_SPECIFICATION.md:4.3`

### 9. Cache Behavior Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (extend integration describe block)

**Test Cases:**

1. **Cache hit after partial invalidation**

- Cache data, invalidate some tiles, request same bbox
- Expected: Partial cache hit, missing tiles fetched

2. **X-Cache header values (HIT, MISS, STALE)**

- Verify all three cache states produce correct headers
- Expected: Correct X-Cache header for each state

3. **X-Cache-Fetched-At header accuracy**

- Verify header reflects oldest tile fetch time
- Expected: Accurate timestamp

4. **Cache behavior with zero TTL**

- Configure TTL=0, verify immediate stale marking
- Expected: Tiles marked stale immediately

**Reference:** `src/interpreter.ts:420-427`, `docs/PRD.md:FR-008`

### 10. Bbox Parsing Edge Cases

**Location:** `src/tests/integration/integration.test.ts` (new describe block: "bbox parsing edge cases")

**Test Cases:**

1. **Handles bbox with comma and space separators**

- Query with `(52.5, 13.3, 52.6, 13.4)` (spaces after commas)
- Expected: Parses correctly

2. **Handles bbox with only spaces as separators**

- Query with `(52.5 13.3 52.6 13.4)` (spaces only)
- Expected: Parses correctly

3. **Rejects bbox with too few coordinates**

- Query with only 2 or 3 coordinates
- Expected: 400 or null bbox

4. **Rejects bbox with too many coordinates**

- Query with 5+ coordinates
- Expected: Uses first 4 or error

5. **Handles bbox at international date line**

- Bbox crossing -180/180 boundary
- Expected: Handled correctly or appropriate error

**Reference:** `src/bbox.ts`, `src/interpreter.ts:75-112`

## Implementation Strategy

1. **Organize by feature area** - Group related tests in describe blocks
2. **Reuse test helpers** - Create helpers for common scenarios (upstream failures, cache setup)
3. **Use existing patterns** - Follow current test structure and assertions
4. **Mock upstream responses** - Use `setResponder` for upstream error scenarios
5. **Test edge cases systematically** - Cover boundary conditions and error paths

## Files to Modify

- `src/tests/integration/integration.test.ts` - Add all new test cases
- Potentially extend `src/tests/integration/mock-overpass.ts` if needed for additional upstream scenarios

## Success Criteria

- All new test cases pass
- Coverage increases for edge cases and error scenarios
- Upstream retry and limit behavior verified end-to-end
- Amenity extraction paths fully covered
- ETag behavior validated for all scenarios
- Concurrent request handling verified