import request from 'supertest';

import { STATISTICS_SNAPSHOT_KEY } from '../../stats.js';
import { createTestEnvironment } from '../integration/testcontainers.js';

const jsonQuery = '[out:json];node["amenity"="toilets"](52.5,13.3,52.6,13.4);out;';
const formBody = (query: string) => new URLSearchParams({ data: query }).toString();

const toPercentile = (values: number[], percentile: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
};

const measureInterpreterP95 = async (baseUrl: string, iterations: number): Promise<number> => {
  const latenciesMs: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    const response = await request(baseUrl)
      .post('/api/interpreter')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formBody(jsonQuery));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    latenciesMs.push(elapsedMs);

    if (![200, 502, 503].includes(response.statusCode)) {
      throw new Error(`Unexpected /api/interpreter status: ${response.statusCode}`);
    }
  }

  return toPercentile(latenciesMs, 95);
};

const run = async (): Promise<void> => {
  const iterations = Math.max(20, Number(process.env.PERF_ITERATIONS ?? 120));
  const warmupIterations = Math.max(10, Number(process.env.PERF_WARMUP_ITERATIONS ?? 30));
  const maxAllowedDeltaMs = Number(process.env.PERF_MAX_P95_DELTA_MS ?? 10);
  process.env.NODE_ENV = 'test';
  const { buildServer } = await import('../../index.js');

  const env = await createTestEnvironment();
  await env.redis.flushall();

  const { app } = await buildServer({
    configOverrides: {
      upstreamUrls: env.upstreamUrls,
      tilePrecision: 5
    },
    redisClient: env.redis
  });

  await app.ready();
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  let stopStressLoop = false;
  const stressLoop = async (): Promise<void> => {
    while (!stopStressLoop) {
      try {
        await env.redis.set(
          STATISTICS_SNAPSHOT_KEY,
          JSON.stringify({ generatedAt: '2020-01-01T00:00:00.000Z', totalRequests: 0 })
        );
        await request(baseUrl).get('/api/statistics');
      } catch {
        // Ignore stress loop errors; measurement is best-effort for CI/dev runs.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  try {
    await measureInterpreterP95(baseUrl, warmupIterations);

    const baselineP95Ms = await measureInterpreterP95(baseUrl, iterations);

    const stressPromise = stressLoop();
    const stressedP95Ms = await measureInterpreterP95(baseUrl, iterations);
    stopStressLoop = true;
    await stressPromise;

    const deltaMs = Number((stressedP95Ms - baselineP95Ms).toFixed(2));

    console.log(`Baseline /api/interpreter p95: ${baselineP95Ms.toFixed(2)}ms`);
    console.log(`Stressed /api/interpreter p95: ${stressedP95Ms.toFixed(2)}ms`);
    console.log(`Delta p95: ${deltaMs.toFixed(2)}ms`);
    console.log(`Gate: delta <= ${maxAllowedDeltaMs.toFixed(2)}ms`);

    if (deltaMs > maxAllowedDeltaMs) {
      throw new Error(
        `Performance gate failed: p95 delta ${deltaMs.toFixed(2)}ms > ${maxAllowedDeltaMs.toFixed(2)}ms`
      );
    }
  } finally {
    stopStressLoop = true;
    await app.close();
    await env.stop();
  }
};

void run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
