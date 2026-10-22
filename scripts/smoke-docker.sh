#!/usr/bin/env bash
set -euo pipefail
docker info >/dev/null
run="overpass-node26-smoke-$$"
redis_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
cleanup() {
  docker rm -f "$run-proxy" "$run-redis" "$run-upstream" >/dev/null 2>&1 || true
  docker network rm "$run" >/dev/null 2>&1 || true
  docker image rm "$run-proxy" "$run-upstream" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -t "$run-proxy" .
docker build -f src/tests/integration/mock-overpass.Dockerfile -t "$run-upstream" .
docker image inspect "$run-proxy" --format 'Production image: {{.Id}}'
git rev-parse HEAD
docker run --rm "$run-proxy" node --version
docker run --rm "$run-proxy" npm --version
docker network create "$run" >/dev/null
docker run -d --name "$run-redis" --network "$run" --network-alias redis redis:8.10.2-alpine redis-server --user default off --user proxy on ">$redis_password" '~*' '&*' '+@all' >/dev/null
docker run -d --name "$run-upstream" --network "$run" --network-alias upstream "$run-upstream" >/dev/null
for attempt in {1..30}; do
  if docker exec -e REDISCLI_AUTH="$redis_password" "$run-redis" redis-cli --user proxy ping | grep -q PONG; then break; fi
  sleep 1
done
# Verify the server actually rejects unauthenticated and incorrect credentials.
if ! docker exec "$run-redis" redis-cli ping 2>&1 | grep -q NOAUTH; then
  echo 'Redis unexpectedly accepted an unauthenticated connection' >&2
  exit 1
fi
if ! docker exec -e REDISCLI_AUTH=incorrect "$run-redis" redis-cli --user proxy ping 2>&1 | grep -q WRONGPASS; then
  echo 'Redis did not reject incorrect ACL credentials' >&2
  exit 1
fi
docker run -d --name "$run-proxy" --network "$run" -e REDIS_URL="redis://proxy:$redis_password@redis:6379" -e UPSTREAM_URL=http://upstream:8081/api/interpreter -e LOG_VERBOSITY=errors "$run-proxy" >/dev/null
if ! docker exec -i "$run-proxy" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8080';
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
let ready = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/statistics-map`)).ok) { ready = true; break; } } catch {}
  await pause();
}
assert.ok(ready, 'compiled server must start and serve operator page');
let upstreamReady = false;
for (let i = 0; i < 30; i++) {
  try {
    const response = await fetch('http://upstream:8081/api/interpreter', {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({data: '[out:json];node["amenity"="toilets"](0,0,1,1);out;'})
    });
    if (response.ok) { upstreamReady = true; break; }
  } catch {}
  await pause();
}
assert.ok(upstreamReady, 'mock upstream must be ready');
const query = '[out:json];node["amenity"="toilets"](52.5,13.3,52.501,13.301);out;';
const upstreamHitCount = async () => {
  const response = await fetch('http://upstream:8081/__test__/hits');
  assert.equal(response.status, 200);
  return (await response.json()).count;
};
const beforeColdRequest = await upstreamHitCount();
let afterColdRequest;
for (const phase of ['cold', 'warm']) {
  const response = await fetch(`${base}/api/interpreter`, {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({data: query})
  });
  assert.equal(response.status, 200, await response.clone().text());
  // Successfully fetched tiles count as resolved, so both responses report HIT.
  assert.equal(response.headers.get('x-cache'), 'HIT');
  assert.ok(Array.isArray((await response.json()).elements));
  const hits = await upstreamHitCount();
  if (phase === 'cold') {
    assert.ok(hits > beforeColdRequest, 'cold request must fetch tiles upstream');
    afterColdRequest = hits;
  } else {
    assert.equal(hits, afterColdRequest, 'warm request must reuse cached tiles without an upstream fetch');
  }
}
let statisticsReady = false;
for (let i = 0; i < 30; i++) {
  const response = await fetch(`${base}/api/statistics`);
  if (response.status === 200 && (await response.json()).pending !== true) { statisticsReady = true; break; }
  await pause();
}
assert.ok(statisticsReady, 'production statistics worker must produce a snapshot');
console.log('Production container smoke checks passed');
JS
then
  docker logs "$run-proxy"
  docker logs "$run-upstream"
  exit 1
fi
