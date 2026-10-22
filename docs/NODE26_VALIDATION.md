# Node 26 validation and rollout

Node 26 (`>=26 <27`) is the only supported runtime. Use `.nvmrc` for local development, `npm ci` for installation, and Node 26 Alpine for containers. No HTTP, environment-variable, or Redis schema changes are part of this migration.

## Local validation — 2026-10-22

Base commit: `a0b5886ba999858625c6a43339f59e7619a9488a`.
The final results below apply to the uncommitted Node 26 migration on that base.
Runtime: Node `v26.12.1`, npm `11.20.0`, Linux x64.

| Check | Unchanged baseline | Migration |
| --- | --- | --- |
| `npm ci` | Passed, no engine warnings | Passed, no engine warnings |
| `npm run verify` | Passed: lint, build, 226 tests / 16 files | Passed: lint, build, 226 tests / 16 files |
| `npm run test:perf:statistics` | Passed: p95 delta 0.23 ms | Passed: p95 delta 0.09 ms |
| Docker / real Redis integration | Unavailable: Docker not installed | Explicit failure for missing Docker; no in-memory fallback |
| Production container smoke | Unavailable: Docker not installed | Script syntax checked; execution blocked by missing Docker |

The latency budget remains 10 ms. No assertions or time limits were relaxed.
The initial runtime migration reported 30 dependency audit findings (9 moderate, 19 high, 2 critical). The subsequent dependency remediation below supersedes that audit result.
Node 26 also emits a `module.register()` deprecation warning through the existing TypeScript loader during local checks; the checks pass.
No production image ID exists from this environment, and container compatibility is not yet certified.

Subsequent dependency updates and final test results are recorded in [dependency validation](DEPENDENCY_VALIDATION.md); the full audit now reports zero findings.

## Reproduce container acceptance

On a host with Node 26 and a working Docker daemon:

```bash
node --version
npm --version
git rev-parse HEAD
npm ci
npm run verify
npm run test:docker
npm run test:perf:statistics
npm run test:smoke:docker
```

The smoke script builds the production and mock images, prints the production image ID and commit, and starts a private network with a disposable Redis instance and local mock upstream. It checks the compiled server, operator page, a cold interpreter request followed by cache reuse (verified through upstream request counts), and a ready statistics snapshot produced with real Redis and the production worker. Containers and network are removed on exit; no production Redis or external Overpass service is used. Save the CI logs with the tested commit and image ID. The temporary smoke images are removed on exit; build and retain the release image separately, then rerun acceptance against the exact retained image before rollout.

## Release gate and rollback

- Production release is blocked until all checks, including Docker acceptance, pass.
- Before release, verify the actual Node 26 LTS transition and current security updates against the [official release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) and [release listings](https://nodejs.org/en/download/current). The planned LTS date is 2026-10-28; do not release earlier.
- Deploy the tested image first to an isolated staging environment with its own Redis. Record the final commit, Node/npm versions, immutable image digest, and acceptance results. If the image changes, repeat acceptance.
- Retain the previous deployment image and configuration. Observe error rate, Redis/upstream failures, latency, and statistics readiness during staged traffic validation. Roll back for new runtime failures or material regressions.
- Node 20 is EOL and is not a supported ongoing fallback. This change performs no automatic deployment or production data migration.
