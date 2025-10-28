Extend the existing “ToiletFinder” project by creating a **new subproject** next to the iOS App, named `overpass-proxy`. 
This subproject must contain a **complete, production-ready Node.js (TypeScript)** implementation of a **transparent Overpass API proxy** with optional Redis-based tile caching and full test coverage.

---

## 📁 Folder placement

Assume the existing structure:

```
/
├── ios-app/
│   └── ...
└── overpass-proxy/
└── (you create everything here)

```

Your task is to create the entire `overpass-proxy/` folder as a self-contained project that can be developed and deployed independently, but remains part of the ToiletFinder monorepo.

---

## 🧩 Project overview

Build a **drop-in transparent Overpass API proxy** that supports:
- identical endpoint paths as the real Overpass API (`/api/interpreter`, `/api/status`, etc.),
- Redis-based tile caching for JSON bbox requests,
- pass-through behavior for all other requests (XML or complex queries),
- full unit + integration tests from the beginning.

This is the backend foundation for the ToiletFinder app, enabling local or hosted fast Overpass access with caching and bounding-box filtering.

---

## 🧠 Functional scope

### Transparency
- Implement **exactly** the Overpass API endpoints:
  - `POST /api/interpreter`
  - `GET  /api/interpreter`
  - `GET  /api/status`
  - `GET  /api/timestamp` and `/api/timestamp/*`
  - `POST /api/kill_my_queries`
  - All other `/api/*` → transparent proxy (no alteration)

- Preserve:
  - All request methods, query params, headers, and body.
  - All upstream status codes and headers (`Content-Type`, `Content-Encoding`, `ETag`, etc.).
  - Support both XML and JSON outputs.
  - Stream non-cacheable requests directly (no buffering).

- Add config flag `TRANSPARENT_ONLY=true` to disable caching completely.

---

### Caching (optional path)
- Cache only if:
  - `out:json` in the query, and
  - a **bounding box (bbox)** can be extracted from the Overpass QL.
- Parse the query *only enough to detect bbox coordinates*. No further parsing is required.

- For cacheable requests:
  - Divide bbox into geohash tiles (`TILE_PRECISION`, default 5).
  - Fetch and store each tile’s elements from upstream as raw Overpass JSON (including all metadata).
  - Reassemble Overpass-compatible responses (meta intact) from cached elements for arbitrary bbox queries.
  - TTL-based cache with stale-while-revalidate (SWR) behavior.
  - If too many tiles (> `MAX_TILES_PER_REQUEST`), respond `413`.

---

### Upstream behavior
- Upstream query per tile:
```
[out:json][timeout:120];
(
node({{bbox}});
way({{bbox}});
relation({{bbox}});
);
out body meta;

> ;
> out skel qt;

```
- Store results in Redis (keys by type and tile).
- Support multiple concurrent tile fetches with rate-limiting and backoff.

---

## ⚙️ Technical stack

- **Language:** Node.js 20 + TypeScript  
- **Framework:** Fastify  
- **Cache:** Redis (via ioredis)  
- **HTTP Client:** got  
- **Tests:** Vitest (unit) + Supertest (integration) + Testcontainers (Redis + mock Overpass)  
- **Linting:** ESLint + TypeScript  
- **CI:** GitHub Actions workflow for lint + tests  

---

## 🗂️ Required files and structure

```

overpass-proxy/
├── src/
│   ├── index.ts               # server bootstrap, routes, transparent proxy logic
│   ├── interpreter.ts         # main dispatcher (cacheable vs transparent)
│   ├── bbox.ts                # bbox extraction from Overpass QL
│   ├── tiling.ts              # geohash utilities
│   ├── upstream.ts            # upstream fetcher (tile QL builder)
│   ├── store.ts               # Redis interaction
│   ├── assemble.ts            # element reassembly + filtering
│   ├── headers.ts             # ETag + header helpers
│   ├── config.ts              # env loader
│   ├── logger.ts              # structured logging
│   ├── errors.ts              # error helpers
│   ├── rateLimit.ts           # lightweight rate limiter
│   └── tests/
│       ├── unit/
│       │   ├── bbox.test.ts
│       │   ├── tiling.test.ts
│       │   ├── assemble.test.ts
│       │   ├── headers.test.ts
│       │   ├── store.test.ts
│       │   └── ...
│       └── integration/
│           ├── integration.test.ts
│           ├── mock-overpass.ts   # fake Overpass server for testing
│           └── testcontainers.ts  # Redis + proxy setup
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .eslintrc.cjs
├── vitest.config.ts
├── README.md
└── .github/workflows/ci.yml

```

---

## 🧪 Test coverage (mandatory)

- **Unit tests:**  
  - BBox parser handles varied QL input (newlines, comments, malformed tuples).  
  - Geohash tiling covers all edge cases.  
  - ETag stability + 304 logic.  
  - Element reassembly correctness (nodes/ways/relations).  
  - Redis store TTL and meta tracking.  

- **Integration tests:**  
  - Transparent pass-through (XML, arbitrary QL).  
  - Cache warm & hit (no upstream on 2nd call).  
  - TTL expiry & stale-while-revalidate.  
  - ETag 304 handling.  
  - `/api/status`, `/api/timestamp`, `/api/kill_my_queries` parity.  
  - MAX_TILES_PER_REQUEST → 413.  
  - TRANSPARENT_ONLY → all pass-through.  

Coverage targets:  
- Lines ≥ 90%, Branches ≥ 85%.  
- Failing coverage gate should fail CI.

---

## 🧩 Configuration (ENV)

| Variable | Default | Description |
|-----------|----------|-------------|
| `UPSTREAM_URL` | `https://overpass-api.de/api/interpreter` | Overpass backend |
| `REDIS_URL` | `redis://redis:6379` | Redis connection |
| `CACHE_TTL_SECONDS` | `86400` | Cache TTL |
| `TILE_PRECISION` | `5` | Geohash precision |
| `MAX_TILES_PER_REQUEST` | `1024` | Limit for cacheable tiles |
| `TRANSPARENT_ONLY` | `false` | Disable caching |
| `PORT` | `8080` | Listen port |
| `NODE_ENV` | `production` | Environment |

---

## 🧰 Docker setup

- `Dockerfile`: build and run Node app (`node:20-alpine`).
- `docker-compose.yml`: runs proxy + Redis sidecar.

---

## 📜 README contents

Include:
- Overview (purpose + transparency guarantee)
- Endpoint documentation
- Environment variables
- How to run locally (`docker-compose up`)
- How to run tests
- Example curl commands (pass-through & cached requests)
- CI explanation

---

## ✅ Acceptance criteria

1. The folder `ToiletFinder/overpass-proxy/` builds independently via `npm run build`.
2. Existing Overpass clients (e.g., ToiletFinder iOS app) can point to this proxy without modification.
3. Non-cacheable requests (XML or missing bbox) → byte-identical to upstream.
4. JSON bbox requests → cached; second identical call hits Redis, verified by integration tests.
5. ETag/304 works; headers match Overpass conventions.
6. Unit + integration tests pass with ≥90% coverage.
7. CI pipeline (`.github/workflows/ci.yml`) runs lint + test + coverage successfully.
8. Project runs in Docker and shares `.env` or network stack with the iOS app environment if desired.

---

Generate the **entire folder structure and files** under `/overpass-proxy/` according to the spec above.

