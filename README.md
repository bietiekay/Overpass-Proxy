# Overpass Proxy

Overpass API proxy specialised for amenity lookups with Redis-backed tile caching for JSON bounding-box queries. The proxy mirrors the official Overpass API surface so existing clients (like the ToiletFinder iOS app) can switch endpoints without any behavioural changes when querying amenities, while respecting whichever amenity type the caller encodes in the Overpass query.

## Summary

The `overpass-proxy` subproject delivers a production-ready Fastify service that mirrors the public Overpass API surface while
adding Redis-backed geohash tile caching for amenity-focused JSON bounding-box queries. It includes:

- Full TypeScript source code covering request routing, caching, upstream proxying, rate limiting, and telemetry helpers.
- A dual-mode testing setup (Vitest + Supertest) that supports local execution without Docker by default, with optional
  Testcontainers-powered Redis and mock Overpass services when `USE_DOCKER=1`.
- Comprehensive documentation in `specification.md`, including architectural deep-dives and a Mermaid flow diagram that traces
  bootstrap, request handling, cache population, and validation paths end-to-end.

## Features

- Fastify-based HTTP server exposing the `/api/*` Overpass endpoints
- Strict amenity-only handling for `/api/interpreter`; non-JSON or non-amenity queries are rejected with helpful errors, and recognised amenity filters are preserved end-to-end
- Redis-backed geohash tile caching for amenity Overpass JSON bbox queries with stale-while-revalidate refresh, segmented by requested amenity type
- Structured logging via Pino
- Comprehensive Vitest unit and integration test suites
- GitHub Actions CI workflow running linting and tests with coverage
- Docker & docker-compose setup for development and deployment

## Endpoints

The proxy implements the core Overpass API endpoints:

- `POST /api/interpreter`
- `GET /api/interpreter`
- `GET /api/status`
- `GET /api/timestamp` and `GET /api/timestamp/*`
- `POST /api/kill_my_queries`
- Any other `/api/*` path is transparently proxied upstream

Requests preserve HTTP methods, headers, payloads, and status codes. `/api/interpreter` requires JSON amenity queries with a bounding box; the proxy satisfies the response locally when tiles are cached and fetches amenity tiles upstream on cache misses.

## Configuration

Environment variables are read at startup. Defaults are shown below:

| Variable | Default | Description |
| --- | --- | --- |
| `UPSTREAM_URL` | `https://overpass-api.de/api/interpreter` | Overpass API endpoint |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `CACHE_TTL_SECONDS` | `86400` | Cache TTL |
| `SWR_SECONDS` | `CACHE_TTL_SECONDS / 10` | Stale-while-revalidate window |
| `TILE_PRECISION` | `5` | Geohash precision for tiles |
| `MAX_TILES_PER_REQUEST` | `1024` | Maximum tiles per request |
| `PORT` | `8080` | Listen port |
| `NODE_ENV` | `production` | Runtime environment |

The defaults for `TILE_PRECISION` and `MAX_TILES_PER_REQUEST` are tuned for the ToiletFinder iOS client: a precision of 5 keeps
tile counts below the 1 024-tile ceiling even for the app’s widest live-map fetches (~70 km across) and cache-preload passes
(~100 km combined width/height) while still yielding reusable tiles for the 2 km spatial grid used during normal browsing.

## Running locally

Install dependencies and build the project:

```bash
npm install
npm run build
```

Launch the proxy (expects a Redis instance reachable via `REDIS_URL`):

```bash
npm start
```

### Docker Compose

A ready-to-run docker-compose configuration is provided:

```bash
docker-compose up --build
```

This starts the proxy along with Redis and a mock Overpass service used for integration tests.

## Testing

The test suite is designed to work both with and without Docker:

- **Default (`npm test`)** – runs unit + integration tests using the in-memory Redis implementation and embedded mock Overpass server. No Docker daemon required.
- **Watch (`npm run test:watch`)** – same as above but in watch mode for quick iteration.
- **Docker-backed (`npm run test:docker`)** – opts into Testcontainers so Redis runs inside Docker when available.
- **Coverage (`npm run test:ci`)** – default non-Docker execution with coverage reporting.

```bash
npm test             # unit + integration without Docker
npm run test:watch   # watch mode without Docker
npm run test:docker  # run the suite with Docker dependencies
npm run test:ci      # coverage-enabled run without Docker
```

## Example requests

```bash
# JSON amenity bbox request (cacheable)
curl -X POST http://localhost:8080/api/interpreter \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data '[out:json];node["amenity"="cafe"](52.5,13.3,52.6,13.4);out;'

# Validation error when amenity filter missing
curl -X POST http://localhost:8080/api/interpreter \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data '[out:json];node(52.5,13.3,52.6,13.4);out;'
```

## Continuous Integration

`.github/workflows/ci.yml` runs linting and tests (with coverage enforcement) on every push and pull request.
