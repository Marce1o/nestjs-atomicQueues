import Redis from 'ioredis';

export async function scanKeys(redis: Redis, pattern: string, count = 100): Promise<string[]> {
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== '0');
  return keys;
}
