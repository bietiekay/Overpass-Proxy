import { execSync } from 'node:child_process';

import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

import { InMemoryRedis } from '../helpers/inMemoryRedis.js';
import { createMockOverpass } from './mock-overpass.js';

export interface TestEnvironment {
  redis: Redis;
  upstreamUrls: string[];
  stop: () => Promise<void>;
  hits: string[];
}

const isDockerAvailable = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const createTestEnvironment = async (): Promise<TestEnvironment> => {
  const dockerWanted = process.env.USE_DOCKER === '1';
  const dockerAvailable = dockerWanted && isDockerAvailable();

  if (dockerAvailable) {
    const redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    const redisPort = redisContainer.getMappedPort(6379);
    const redisHost = redisContainer.getHost();
    const redis = new Redis({ host: redisHost, port: redisPort });

    const mockOverpass = createMockOverpass();
    await mockOverpass.start(0);
    const address = mockOverpass.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return {
      redis,
      upstreamUrls: [`http://127.0.0.1:${port}/api/interpreter`],
      hits: mockOverpass.hits,
      stop: async () => {
        await redis.quit();
        await mockOverpass.stop();
        await (redisContainer as StartedTestContainer).stop();
      }
    };
  }

  const mockRedis = new InMemoryRedis();
  const mockOverpass = createMockOverpass();
  await mockOverpass.start(0);
  const address = mockOverpass.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    redis: mockRedis as unknown as Redis,
    upstreamUrls: [`http://127.0.0.1:${port}/api/interpreter`],
    hits: mockOverpass.hits,
    stop: async () => {
      await mockRedis.quit();
      await mockOverpass.stop();
    }
  };
};
