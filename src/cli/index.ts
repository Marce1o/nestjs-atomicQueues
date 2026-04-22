#!/usr/bin/env node

import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { generateTypeScript } from './generators/typescript';
import { generateJsonSchema } from './generators/json-schema';
import { RegistrySnapshot, EntityContract } from '../services/registry/registry.types';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  if (command !== 'generate') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const format = args.includes('--ts') ? 'ts'
    : args.includes('--json-schema') ? 'json-schema'
    : args.includes('--snapshot') ? 'snapshot'
    : null;

  if (!format) {
    console.error('Specify a format: --ts, --json-schema, or --snapshot');
    process.exit(1);
  }

  const outputIdx = args.indexOf('--output');
  const output = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const prefixIdx = args.indexOf('--prefix');
  const keyPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'aq';

  const redis = new Redis(redisUrl);
  const snapshot = await fetchSnapshot(redis, keyPrefix);
  await redis.quit();

  if (snapshot.entities.length === 0) {
    console.error('No entity types found in the registry. Is the registry enabled and are services running?');
    process.exit(1);
  }

  let content: string;
  let defaultFilename: string;

  switch (format) {
    case 'ts':
      content = generateTypeScript(snapshot);
      defaultFilename = 'contracts.ts';
      break;
    case 'json-schema':
      content = JSON.stringify(generateJsonSchema(snapshot), null, 2);
      defaultFilename = 'schemas.json';
      break;
    case 'snapshot':
      content = JSON.stringify(snapshot, null, 2);
      defaultFilename = 'registry-snapshot.json';
      break;
    default:
      throw new Error(`Unknown format: ${format}`);
  }

  if (output) {
    const outputPath = path.resolve(output);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, content, 'utf-8');
    console.log(`Generated ${format} output: ${outputPath}`);
  } else {
    console.log(content);
  }
}

async function fetchSnapshot(redis: Redis, keyPrefix: string): Promise<RegistrySnapshot> {
  const pattern = `${keyPrefix}:registry:*`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== '0');

  const entities: EntityContract[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (raw) {
      entities.push(JSON.parse(raw));
    }
  }

  return {
    generatedAt: Date.now(),
    keyPrefix,
    entities,
  };
}

function printUsage(): void {
  console.log(`
atomic-queues CLI

Usage:
  npx atomic-queues generate --ts [--output <path>]          Generate TypeScript interfaces
  npx atomic-queues generate --json-schema [--output <path>] Generate JSON Schema
  npx atomic-queues generate --snapshot [--output <path>]    Export full registry snapshot

Options:
  --output <path>     Write to file instead of stdout
  --prefix <prefix>   Redis key prefix (default: 'aq')

Environment:
  REDIS_URL           Redis connection URL (default: redis://localhost:6379)

Examples:
  REDIS_URL=redis://prod:6379 npx atomic-queues generate --ts --output ./generated/contracts.ts
  npx atomic-queues generate --json-schema --output ./schemas/atomic.json
  npx atomic-queues generate --snapshot
  `);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
