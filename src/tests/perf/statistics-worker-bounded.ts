import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { Worker } from 'node:worker_threads';
import { setTimeout as pause } from 'node:timers/promises';
import Redis from 'ioredis';
import ngeohash from 'ngeohash';
import { loadConfig } from '../../config.js';
import { StatisticsWorkerClient, type PersistedStatisticsState } from '../../stats.js';

// Isolated local Redis; never connects to an operator's configured database.
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const server = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
const redisUrl = `redis://127.0.0.1:${port}`;
const redis = new Redis(redisUrl, { lazyConnect: true, retryStrategy: null });
redis.on('error', () => undefined);
let client: StatisticsWorkerClient | undefined;
try {
  for (let attempt = 0; ; attempt++) {
    try { await redis.connect(); break; } catch (error) { if (attempt >= 30) throw error; await pause(50); }
  }
  process.env.STATS_BATCH_INTERVAL_MS = '50';
  process.env.STATS_PERSIST_INTERVAL_MS = '100';
  process.env.STATS_SNAPSHOT_INTERVAL_MS = '600000';
  await redis.call('ACL', 'SETUSER', 'stats-validation', 'on', '>local-validation', '~*', '+@all');
  const workerRedisUrl = `redis://stats-validation:local-validation@127.0.0.1:${port}`;
  const config = { ...loadConfig(), upstreamUrls: [], redisUrl: workerRedisUrl };
  client = new StatisticsWorkerClient({ config, redis, redisUrl: workerRedisUrl, useWorker: true });
  await client.ready();
  const worker = (client as unknown as { worker: Worker }).worker;
  const notificationAck = (): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', listener); reject(new Error('notification channel stalled after refresh failure')); }, 2000);
    const listener = (message: { type?: string }): void => {
      if (message.type !== 'notificationAck') return;
      clearTimeout(timer); worker.off('message', listener); resolve();
    };
    worker.on('message', listener);
  });
  // Deny only the worker's snapshot reads; a failed refresh must still release its ACK slot.
  await redis.call('ACL', 'SETUSER', 'stats-validation', '-get');
  const failedRefreshAck = notificationAck();
  client.refresh('all');
  await failedRefreshAck;
  await redis.call('ACL', 'SETUSER', 'stats-validation', '+get');
  const recoveredNotificationAck = notificationAck();
  client.markDirty('statistics');
  await recoveredNotificationAck;
  const requests = 20_000;
  const start = performance.now();
  for (let i = 0; i < requests; i++) {
    const lat = -80 + (i % 160), lon = -179 + (i * 17 % 358);
    client.recordRequest({ amenity: `amenity-${i % 400}`, clientIp: `192.0.${Math.floor(i % 1500 / 256)}.${i % 256}`, bbox: { south: lat, north: lat + .01, west: lon, east: lon + .01 }, cacheStatus: i % 2 ? 'HIT' : 'MISS', tileCount: 2, tiles: [{ hash: ngeohash.encode(lat, lon, 5), bounds: { south: lat, north: lat + .01, west: lon, east: lon + .01 } }] });
  }
  const foregroundMs = performance.now() - start;
  await pause(150);
  // A second batch exercises period-delta reset and shutdown flushing.
  client.recordRequest({ amenity: 'toilets', clientIp: '192.0.0.1', bbox: { south: 52, north: 53, west: 13, east: 14 }, cacheStatus: 'STALE', tileCount: 3 });
  await client.stop();
  client = undefined;
  const state = JSON.parse((await redis.get('statistics:current')) ?? 'null') as PersistedStatisticsState | null;
  assert(state);
  assert.equal(state.totalRequests, requests + 1);
  assert.equal(state.totalRequestsDay, requests + 1);
  assert.equal(state.totalTiles, requests * 2 + 3);
  assert.equal(state.cacheStatusCounts.HIT, requests / 2);
  assert.equal(state.cacheStatusCounts.MISS, requests / 2);
  assert.equal(state.cacheStatusCounts.STALE, 1);
  assert(state.amenities.length <= 257);
  const cells = state.amenities.reduce((sum, item) => sum + item.geohashCounts.length, 0);
  assert(cells <= 20_000);
  console.log(JSON.stringify({ requests: requests + 1, foregroundMs: Math.round(foregroundMs), persistedAmenities: state.amenities.length, persistedGeohashCells: cells, exactCounters: true, notificationRecovery: true }));
} finally {
  await client?.stop();
  redis.disconnect();
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); });
}
