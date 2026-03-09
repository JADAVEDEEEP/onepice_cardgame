let createClient = null;
try {
  ({ createClient } = require("redis"));
} catch {
  createClient = null;
}

const memoryCache = new Map();
let redisClient = null;
let redisInitTried = false;
let redisReady = false;
let redisLastAttemptAt = 0;
let redisInitPromise = null;

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || "optcg:";
const REDIS_RETRY_MS = Math.max(5_000, Number(process.env.REDIS_RETRY_MS) || 30_000);
const REDIS_CONNECT_TIMEOUT_MS = Math.max(
  300,
  Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 1200
);

const normalizeTtlMs = (ttlMs) => {
  const n = Number(ttlMs);
  if (!Number.isFinite(n) || n <= 0) return 60_000;
  return Math.max(1000, n);
};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`redis_connect_timeout_${ms}ms`)), ms)
    ),
  ]);

const getRedisClient = async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || !createClient) return null;
  if (redisReady && redisClient) return redisClient;
  if (redisInitPromise) return null;
  if (redisInitTried && !redisReady && Date.now() - redisLastAttemptAt < REDIS_RETRY_MS) {
    return null;
  }

  redisInitTried = true;
  redisLastAttemptAt = Date.now();
  redisInitPromise = (async () => {
    try {
      const client = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
          reconnectStrategy: false,
        },
      });
      client.on("error", () => {
        redisReady = false;
      });
      await withTimeout(client.connect(), REDIS_CONNECT_TIMEOUT_MS);
      redisClient = client;
      redisReady = true;
      return client;
    } catch {
      redisReady = false;
      if (redisClient && redisClient.isOpen) {
        try {
          await redisClient.quit();
        } catch {
          // no-op
        }
      }
      redisClient = null;
      return null;
    } finally {
      redisInitPromise = null;
    }
  })();

  // Do not block API responses waiting for Redis connection.
  return null;
};

const getMemory = (key) => {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value;
};

const setMemory = (key, value, ttlMs) => {
  memoryCache.set(key, { value, expiresAt: Date.now() + normalizeTtlMs(ttlMs) });
};

const cacheGetJson = async (key) => {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;
  const client = await getRedisClient();
  if (client) {
    try {
      const raw = await client.get(cacheKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  return getMemory(cacheKey);
};

const cacheSetJson = async (key, value, ttlMs) => {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;
  const ttl = normalizeTtlMs(ttlMs);
  const client = await getRedisClient();
  if (client) {
    try {
      await client.set(cacheKey, JSON.stringify(value), { PX: ttl });
      return;
    } catch {
      // no-op and fall back below
    }
  }
  setMemory(cacheKey, value, ttl);
};

const cacheDel = async (key) => {
  const cacheKey = `${CACHE_KEY_PREFIX}${key}`;
  const client = await getRedisClient();
  if (client) {
    try {
      await client.del(cacheKey);
    } catch {
      // no-op
    }
  }
  memoryCache.delete(cacheKey);
};

const cacheDelByPrefix = async (prefix) => {
  const fullPrefix = `${CACHE_KEY_PREFIX}${prefix}`;
  const client = await getRedisClient();
  if (client) {
    try {
      const pattern = `${fullPrefix}*`;
      const keys = [];
      for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keys.push(key);
        if (keys.length >= 500) break;
      }
      if (keys.length > 0) {
        await client.del(keys);
      }
    } catch {
      // no-op
    }
  }

  for (const key of memoryCache.keys()) {
    if (key.startsWith(fullPrefix)) {
      memoryCache.delete(key);
    }
  }
};

module.exports = {
  cacheGetJson,
  cacheSetJson,
  cacheDel,
  cacheDelByPrefix,
};
