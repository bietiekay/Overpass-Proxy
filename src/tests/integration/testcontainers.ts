import { execSync } from 'node:child_process';

import { got } from 'got';
import Redis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

import { InMemoryRedis } from '../helpers/inMemoryRedis.js';
import { createMockOverpass } from './mock-overpass.js';

export interface TestEnvironment {
  redis: Redis;
  upstreamUrls: string[];
  stop: () => Promise<void>;
  hits: string[];
  setResponder?: ReturnType<typeof createMockOverpass>['setResponder'];
  resetResponder?: ReturnType<typeof createMockOverpass>['resetResponder'];
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
    const upstreamUrl = `http://127.0.0.1:${port}/api/interpreter`;

    // Wait for server to be ready by making a test request
    // This ensures the server is actually listening and responding
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const response = await got.post(upstreamUrl, {
          form: { data: '[out:json];node["amenity"="toilets"](0,0,1,1);out;' },
          throwHttpErrors: false,
          timeout: { request: 1000 }
        });
        if (response.statusCode === 200) {
          break;
        }
      } catch (error) {
        if (attempt === 9) {
          throw new Error(`Mock upstream server not ready after 10 attempts: ${error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return {
      redis,
      upstreamUrls: [upstreamUrl],
      hits: mockOverpass.hits,
      setResponder: mockOverpass.setResponder,
      resetResponder: mockOverpass.resetResponder,
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
  const upstreamUrl = `http://127.0.0.1:${port}/api/interpreter`;

  // Wait for server to be ready by making a test request
  // This ensures the server is actually listening and responding
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await got.post(upstreamUrl, {
        form: { data: '[out:json];node["amenity"="toilets"](0,0,1,1);out;' },
        throwHttpErrors: false,
        timeout: { request: 1000 }
      });
      if (response.statusCode === 200) {
        break;
      }
    } catch (error) {
      if (attempt === 9) {
        throw new Error(`Mock upstream server not ready after 10 attempts: ${error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return {
    redis: mockRedis as unknown as Redis,
    upstreamUrls: [upstreamUrl],
    hits: mockOverpass.hits,
    setResponder: mockOverpass.setResponder,
    resetResponder: mockOverpass.resetResponder,
    stop: async () => {
      await mockRedis.quit();
      await mockOverpass.stop();
    }
  };
};
