# Dependency security update — 2026-10-22

Validated with Node 26.12.1 and npm 11.20.0 on the working tree based on commit `a0b5886ba999858625c6a43339f59e7619a9488a`. Existing Node 26 and Redis migration changes are included; nothing has been deployed.

## Production dependencies first

Updated compatible versions in the lockfile, then raised the direct Fastify minimum to `^5.12.7`:

| Previously flagged package | Resolved version(s) |
| --- | --- |
| fastify | 5.12.7 |
| ajv | 6.15.0 / 8.20.0 |
| fast-uri | 3.1.9 / 4.2.3 |
| find-my-way | 9.10.0 |
| http-cache-semantics | 4.3.0 |

`npm audit --omit=dev` reported zero findings after the production update. A clean `npm ci` and `npm run verify` passed (lint, TypeScript build, 226 tests) before updating test dependencies.

## Test dependencies second

Updated Vitest and its matching V8 coverage provider to 5.0.5, Testcontainers to 12.2.1, Supertest to 7.3.1, its types to 7.2.1, and tsx to 4.23.15. Compatible transitive fixes were resolved into the lockfile. The missing coverage provider is now explicitly declared so `npm run test:ci` runs non-interactively.

After clean installation, `npm audit` reported zero findings across production and development dependencies, and `npm run verify` again passed all 226 tests in 16 files. No test assertions or timing budgets were relaxed.

`npm run test:ci` also passed all 226 tests with V8 coverage: statements 81.43%, branches 69.42%, functions 85.59%, lines 81.44%. `npm run test:perf:statistics` passed with a p95 delta of 0.06 ms against the unchanged 10 ms budget.

The Docker test command was retried and failed explicitly because Docker is not installed. Real Redis 8 and production-container acceptance remain pending on a Docker-capable host/CI.

## Follow-up: Docker CI statistics failures

The first Docker CI run exposed assumptions that the statistics implementation ran in the main process. Behavioral integration tests now explicitly select inline statistics so their main-process spies and synchronous snapshot checks remain meaningful with real Redis. The stale-snapshot recovery test explicitly selects the production worker; production still selects the worker automatically for real Redis.

A genuine cache defect was also fixed: reading a stored snapshot cleared an explicit dirty flag, cancelling worker-triggered rebuilds when no request revision changed. A regression test now verifies that explicit invalidation produces a new snapshot while preserving non-blocking reads.

Validation under Node 26.12.1: lint, build, and 227 tests passed. For diagnosis only, the testcontainer launcher was temporarily replaced with isolated local Redis 6.0.16 processes using random ACL passwords; all 227 tests, including worker recovery, then passed. The launcher was restored after this run. This does not constitute a Docker or Redis 8 acceptance result; GitHub CI must confirm those.
