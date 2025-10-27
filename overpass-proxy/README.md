# Overpass Proxy

Transparent Overpass API proxy with optional Redis-backed tile caching for JSON bounding-box queries. The proxy mirrors the official Overpass API surface so existing clients (like the ToiletFinder iOS app) can switch endpoints without any behavioural changes.

## Features

- Fastify-based HTTP server exposing the `/api/*` Overpass endpoints
- Transparent pass-through for non-cacheable requests (XML, complex QL)
- Redis-backed geohash tile caching for Overpass JSON bbox queries with stale-while-revalidate refresh
- Optional `TRANSPARENT_ONLY` mode to disable caching entirely
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

Requests preserve HTTP methods, headers, payloads, and status codes. For cacheable Overpass QL requests (`out:json` with a bbox) the proxy satisfies the response locally when tiles are cached.

## Configuration

Environment variables are read at startup. Defaults are shown below:

| Variable | Default | Description |
| --- | --- | --- |
| `UPSTREAM_URL` | `https://overpass-api.de/api/interpreter` | Overpass API endpoint |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `CACHE_TTL_SECONDS` | `86400` | Cache TTL |
| `SWR_SECONDS` | `CACHE_TTL_SECONDS / 10` | Stale-while-revalidate window |
| `TILE_PRECISION` | `7` | Geohash precision for tiles |
| `MAX_TILES_PER_REQUEST` | `400` | Maximum tiles per request |
| `TRANSPARENT_ONLY` | `false` | Disable caching when `true` |
| `PORT` | `8080` | Listen port |
| `NODE_ENV` | `production` | Runtime environment |

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
# Transparent XML request
curl -X GET "http://localhost:8080/api/interpreter?data=%5Bout:xml%5D;node(52.5,13.3,52.6,13.4);out;"

# JSON bbox request (cacheable)
curl -X POST http://localhost:8080/api/interpreter \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data '[out:json];node(52.5,13.3,52.6,13.4);out;'
```

## Continuous Integration

`.github/workflows/ci.yml` runs linting and tests (with coverage enforcement) on every push and pull request.
