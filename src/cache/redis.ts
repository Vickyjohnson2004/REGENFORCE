import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface CacheBackend {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  health(): Promise<boolean>;
}

class InMemoryCache implements CacheBackend {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly maxEntries = 1_000;

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = config.redisTtlSeconds): Promise<void> {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async health(): Promise<boolean> {
    return true;
  }
}

class RedisCache implements CacheBackend {
  constructor(private readonly client: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = config.redisTtlSeconds): Promise<void> {
    await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async clear(): Promise<void> {
    await this.client.flushdb();
  }

  async health(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === "PONG";
    } catch {
      return false;
    }
  }
}

function createBackend(): CacheBackend {
  if (!config.redisUrl) {
    logger.info("REDIS_URL not set; using in-memory cache");
    return new InMemoryCache();
  }
  const client = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  client.on("error", (err: Error) => logger.warn({ err: err.message }, "Redis error"));
  return new RedisCache(client);
}

export const cache: CacheBackend = createBackend();
