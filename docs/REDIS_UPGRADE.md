# Redis 8 upgrade and authentication

Target: Redis 8.10.2 Alpine (current stable release verified on 2026-10-22).
The existing ioredis client supports Redis username/password authentication and TLS through `REDIS_URL`; no HTTP API or cache schema change is needed. The statistics worker receives the same connection URL.

Redis authentication is not newly mandatory in Redis 8. The default ACL user still permits passwordless access unless configured otherwise. The supplied Compose deployment now requires a password explicitly. See the [Redis security documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/security/) and [8.10.2 release](https://github.com/redis/redis/releases/tag/8.10.2).

## Configuration

- Copy `docker-compose.yml.template` to `docker-compose.yml`; use modern `docker compose`.
- Set `REDIS_PASSWORD` and `REDIS_URL` in a local `.env`, as documented in the README. Both are required by Compose. Do not commit credentials.
- The bundled Redis instance uses `requirepass` (the `default` ACL user). Named external ACL users work with `redis://username:password@host:6379/0`. Percent-encode URL credential components. Use `rediss://` for TLS.
- Existing external Redis connections without credentials remain supported; no new application-level password requirement is imposed.
- ACL test users have `~* &* +@all` and default-user access is disabled. These permissions exercise existing application operations; this change does not claim to provide a minimum-permission production ACL profile.

## Validation and release

`npm run test:docker` uses Redis 8.10.2 with a randomly generated named ACL user. The test wrapper passes the injected client's credentials and database to the statistics worker as well as the main client.

`npm run test:smoke:docker` builds the production image and starts an isolated authenticated Redis 8.10.2. It checks rejection of missing and wrong credentials, valid ACL authentication, cold-cache fetch and warm-cache reuse, operator HTML, and statistics readiness through the compiled worker. Passwords are generated for each run. Docker must be available; no in-memory fallback is accepted.

Docker is not installed in the development environment used for this change. Redis 8 container integration and smoke acceptance therefore remain pending CI execution. Do not infer Redis 8 certification from the in-memory suite or from the locally installed Redis 6 server.

Local validation on 2026-10-22 under Node 26.12.1: `npm run verify` passed (lint, build, 226 tests). An isolated local Redis 6.0.16 ACL check rejected missing/wrong credentials and confirmed that a percent-encoded password connects both the main client and compiled statistics worker. This is an authentication-path check, not Redis 8 validation. Worker shutdown emitted the existing “statistics worker exited unexpectedly” log after successful checks; Docker acceptance remains required.

## Existing data and rollback

Before upgrading, stop writes and back up the existing Redis data directory and deployment configuration. Start Redis 8 in staging against a copy of that data, with authentication configured, and verify startup, cached responses and statistics before switching traffic. Do not point acceptance tests at production Redis: the integration suite uses `FLUSHALL`.

Retain the old image and untouched backup. Redis 8 persistence files are not assumed readable by Redis 7; rollback means restoring the matching backup and previous deployment, not opening newly written Redis 8 files with the older server. Cache contents may instead be discarded and rebuilt if operationally acceptable. No automatic upgrade or deployment is performed by this change.
