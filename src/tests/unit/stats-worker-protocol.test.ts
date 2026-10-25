import { afterEach, describe, expect, it } from 'vitest';
import type { Worker } from 'node:worker_threads';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config.js';
import { StatisticsWorkerClient } from '../../stats.js';
import { InMemoryRedis } from '../helpers/inMemoryRedis.js';

type FixtureMessage = {
  type: string;
  commandType?: string;
  batchId?: string;
  notificationId?: number;
  appliedRequests?: number;
};
type ClientWithWorker = { worker: Worker | null };

const config = { cacheTtlSeconds: 60, swrSeconds: 30, staleRefreshCoarsePrecision: 3, tilePrecision: 5 } as AppConfig;
const fixtureWorkerPath = new URL('../fixtures/statsWorkerFixture.mjs', import.meta.url);
const clients: StatisticsWorkerClient[] = [];
const originalInterval = process.env.STATS_BATCH_INTERVAL_MS;
const originalRetry = process.env.STATS_BATCH_RETRY_MS;

const createClient = (): StatisticsWorkerClient => {
  const client = new StatisticsWorkerClient({
    config,
    redis: new InMemoryRedis() as unknown as Redis,
    redisUrl: 'redis://127.0.0.1:6379',
    workerPath: fixtureWorkerPath,
    useWorker: true
  });
  clients.push(client);
  return client;
};

const workerFor = (client: StatisticsWorkerClient): Worker => {
  const worker = (client as unknown as ClientWithWorker).worker;
  if (!worker) throw new Error('expected worker-backed statistics client');
  return worker;
};

const waitForMessage = (worker: Worker, predicate: (message: FixtureMessage) => boolean, timeoutMs = 2500): Promise<FixtureMessage> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      reject(new Error('timed out waiting for fixture worker message'));
    }, timeoutMs);
    const onMessage = (message: FixtureMessage): void => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      resolve(message);
    };
    worker.on('message', onMessage);
  });

const request = (clientIp: string) => {
  const timestamp = Date.now();
  return {
    amenity: 'toilets', clientIp, bbox: { north: 1, south: 0, east: 1, west: 0 },
    cacheStatus: 'HIT' as const, tileCount: 1, timestamp
  };
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  if (originalInterval === undefined) delete process.env.STATS_BATCH_INTERVAL_MS;
  else process.env.STATS_BATCH_INTERVAL_MS = originalInterval;
  if (originalRetry === undefined) delete process.env.STATS_BATCH_RETRY_MS;
  else process.env.STATS_BATCH_RETRY_MS = originalRetry;
});

describe('statistics worker ingress protocol', () => {
  it('retries one batch id, bounds outstanding messages, and drains the next batch exactly once after ACK', async () => {
    process.env.STATS_BATCH_INTERVAL_MS = '50';
    process.env.STATS_BATCH_RETRY_MS = '250';
    const client = createClient();
    const worker = workerFor(client);
    await client.ready();
    const observedBatchIds: string[] = [];
    const observeBatch = (message: FixtureMessage): void => {
      if (message.type === 'fixtureSeen' && message.commandType === 'recordBatch' && message.batchId) observedBatchIds.push(message.batchId);
    };
    worker.on('message', observeBatch);

    client.recordRequest(request('192.0.2.1'));
    const first = await waitForMessage(worker, (message) => message.type === 'fixtureSeen' && message.commandType === 'recordBatch');
    if (!first.batchId) throw new Error('fixture batch id missing');
    client.recordRequest(request('192.0.2.2'));
    client.recordRequest(request('192.0.2.3'));

    const repeats: string[] = [first.batchId];
    while (repeats.length < 4) {
      const retry = await waitForMessage(worker, (message) => message.type === 'fixtureSeen' && message.commandType === 'recordBatch');
      repeats.push(retry.batchId ?? '');
    }
    expect(new Set(repeats)).toEqual(new Set([first.batchId]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(observedBatchIds).toHaveLength(4);
    expect(client.getPendingRecordPosts()).toBe(2);
    worker.off('message', observeBatch);

    worker.postMessage({ type: 'fixtureAckBatch', batchId: first.batchId });
    const second = await waitForMessage(worker, (message) => message.type === 'fixtureSeen' && message.commandType === 'recordBatch' && message.batchId !== first.batchId);
    if (!second.batchId) throw new Error('second fixture batch id missing');
    worker.postMessage({ type: 'fixtureAckBatch', batchId: second.batchId });
    const report = await waitForMessage(worker, (message) => message.type === 'fixtureReport' && message.appliedRequests === 3);
    expect(report.appliedRequests).toBe(3);
    expect(client.getPendingRecordPosts()).toBe(0);
  });

  it('keeps a notification flood to one in-flight command and one coalesced follow-up', async () => {
    process.env.STATS_BATCH_INTERVAL_MS = '50';
    const client = createClient();
    const worker = workerFor(client);
    await client.ready();
    let notificationCount = 0;
    const observeNotification = (message: FixtureMessage): void => {
      if (message.type === 'fixtureSeen' && message.commandType === 'notifications') notificationCount++;
    };
    worker.on('message', observeNotification);
    client.markDirty('statistics');
    const first = await waitForMessage(worker, (message) => message.type === 'fixtureSeen' && message.commandType === 'notifications');
    if (first.notificationId === undefined) throw new Error('fixture notification id missing');
    for (let i = 0; i < 200; i++) client.markDirty('statistics');
    await new Promise((resolve) => setTimeout(resolve, 100));
    worker.postMessage({ type: 'fixtureAckNotification', notificationId: first.notificationId });
    const second = await waitForMessage(worker, (message) => message.type === 'fixtureSeen' && message.commandType === 'notifications');
    if (second.notificationId === undefined) throw new Error('second fixture notification id missing');
    worker.postMessage({ type: 'fixtureAckNotification', notificationId: second.notificationId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notificationCount).toBe(2);
    worker.off('message', observeNotification);
    expect(client.getPendingRecordPosts()).toBe(0);
  });

  it('stops promptly after the worker exits', async () => {
    process.env.STATS_BATCH_INTERVAL_MS = '50';
    const client = createClient();
    const worker = workerFor(client);
    await client.ready();
    client.recordRequest(request('192.0.2.9'));
    await worker.terminate();
    const startedAt = Date.now();
    await client.stop();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(client.getPendingRecordPosts()).toBe(0);
  });
});
