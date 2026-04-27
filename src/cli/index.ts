#!/usr/bin/env node

import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { generateTypeScript } from './generators/typescript';
import { generateJsonSchema } from './generators/json-schema';
import { generateClasses } from './generators/classes';
import { RegistrySnapshot, EntityContract } from '../domain/interfaces/registry.types';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];

  if (command === 'introspect') {
    return runIntrospect(args.slice(1));
  }

  if (command === 'generate') {
    return runGenerate(args.slice(1));
  }

  if (command === 'dlq') {
    return runDlq(args.slice(1));
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

// ─── introspect ──────────────────────────────────────────────────────────────

async function runIntrospect(args: string[]): Promise<void> {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const prefixIdx = args.indexOf('--prefix');
  const keyPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'aq';
  const entityFilter = args.find((a) => !a.startsWith('--'));

  const redis = new Redis(redisUrl);
  const snapshot = await fetchSnapshot(redis, keyPrefix);
  await redis.quit();

  if (snapshot.entities.length === 0) {
    console.log('No entity types found in the registry.');
    console.log('Is the registry enabled and are services running?');
    process.exit(0);
  }

  const entities = entityFilter
    ? snapshot.entities.filter((e) => e.entityType === entityFilter)
    : snapshot.entities;

  if (entityFilter && entities.length === 0) {
    console.error(`Entity type '${entityFilter}' not found in the registry.`);
    console.log(`Available: ${snapshot.entities.map((e) => e.entityType).join(', ')}`);
    process.exit(1);
  }

  console.log('');
  console.log(
    `  Cluster Registry  (prefix: ${keyPrefix}, ${snapshot.entities.length} entity types)`,
  );
  console.log('');

  for (const entity of entities) {
    const msgCount = Object.keys(entity.messages).length;
    console.log(`  ${entity.entityType}  (service: ${entity.serviceName}, ${msgCount} messages)`);

    for (const [msgName, spec] of Object.entries(entity.messages)) {
      const tag = spec.kind === 'query' ? 'query' : 'cmd  ';
      const fields = formatFields(spec);
      console.log(`    [${tag}]  ${msgName}`);
      if (fields.length > 0) {
        for (const field of fields) {
          console.log(`              ${field}`);
        }
      }
      if (spec.kind === 'query' && spec.replySchema?.properties) {
        const replyFields = formatSchemaFields(spec.replySchema);
        console.log(`              -> returns:`);
        for (const field of replyFields) {
          console.log(`                 ${field}`);
        }
      }
    }
    console.log('');
  }

  console.log(`  Usage (cross-service, no class needed):`);
  console.log('');

  const first = entities[0];
  const firstMsg = Object.entries(first.messages)[0];
  if (firstMsg) {
    const [name, spec] = firstMsg;
    const exampleData = buildExampleData(spec);
    console.log(
      `    await queueBus.enqueue('${first.entityType}', '${name}', entityId, ${exampleData});`,
    );
  }
  console.log('');
}

interface JsonSchemaLike {
  type?: string;
  items?: JsonSchemaLike;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
}

function formatFields(spec: { schema?: JsonSchemaLike }): string[] {
  if (!spec.schema?.properties) return [];
  return formatSchemaFields(spec.schema);
}

function formatSchemaFields(schema: JsonSchemaLike): string[] {
  if (!schema.properties) return [];
  const required = new Set<string>(schema.required ?? []);

  return Object.entries(schema.properties).map(([name, propSchema]) => {
    const type = jsonSchemaTypeLabel(propSchema);
    const opt = required.has(name) ? '' : '?';
    return `${name}${opt}: ${type}`;
  });
}

function jsonSchemaTypeLabel(schema: JsonSchemaLike): string {
  if (!schema.type) return 'unknown';
  switch (schema.type) {
    case 'string':
      return schema.enum ? schema.enum.map((v) => `"${v}"`).join(' | ') : 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return schema.items ? `${jsonSchemaTypeLabel(schema.items)}[]` : 'unknown[]';
    case 'object':
      return 'object';
    case 'null':
      return 'null';
    default:
      return 'unknown';
  }
}

function buildExampleData(spec: { schema?: JsonSchemaLike }): string {
  if (!spec.schema?.properties) return '{ ... }';
  const entries = Object.entries(spec.schema.properties).map(([name, propSchema]) => {
    const type = propSchema.type;
    const example =
      type === 'string'
        ? `'...'`
        : type === 'number' || type === 'integer'
          ? '0'
          : type === 'boolean'
            ? 'true'
            : '...';
    return `${name}: ${example}`;
  });
  return `{ ${entries.join(', ')} }`;
}

// ─── generate ────────────────────────────────────────────────────────────────

async function runGenerate(args: string[]): Promise<void> {
  const format = args.includes('--classes')
    ? 'classes'
    : args.includes('--ts')
      ? 'ts'
      : args.includes('--json-schema')
        ? 'json-schema'
        : args.includes('--snapshot')
          ? 'snapshot'
          : null;

  if (!format) {
    console.error('Specify a format: --classes, --ts, --json-schema, or --snapshot');
    process.exit(1);
  }

  const outputIdx = args.indexOf('--output');
  const outputArg = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
  const shortOutputIdx = args.indexOf('-o');
  const output = outputArg ?? (shortOutputIdx >= 0 ? args[shortOutputIdx + 1] : undefined);

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const prefixIdx = args.indexOf('--prefix');
  const keyPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'aq';

  const entitiesIdx = args.indexOf('--entities');
  const entitiesFilter = entitiesIdx >= 0 ? args[entitiesIdx + 1]?.split(',') : undefined;

  const redis = new Redis(redisUrl);
  const snapshot = await fetchSnapshot(redis, keyPrefix);
  await redis.quit();

  if (snapshot.entities.length === 0) {
    console.error(
      'No entity types found in the registry. Is the registry enabled and are services running?',
    );
    process.exit(1);
  }

  if (entitiesFilter) {
    snapshot.entities = snapshot.entities.filter((e) => entitiesFilter.includes(e.entityType));
    if (snapshot.entities.length === 0) {
      console.error(
        `No matching entity types. Available: ${snapshot.entities.map((e) => e.entityType).join(', ')}`,
      );
      process.exit(1);
    }
  }

  // --classes writes multiple files to a directory
  if (format === 'classes') {
    const outputDir = output ? path.resolve(output) : path.resolve('generated');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const files = generateClasses(snapshot);
    for (const file of files) {
      const filePath = path.join(outputDir, file.filename);
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }

    console.log(`Generated ${files.length} files in ${outputDir}/`);
    for (const file of files) {
      console.log(`  ${file.filename}`);
    }
    return;
  }

  // Single-file formats
  let content: string;

  switch (format) {
    case 'ts':
      content = generateTypeScript(snapshot);
      break;
    case 'json-schema':
      content = JSON.stringify(generateJsonSchema(snapshot), null, 2);
      break;
    case 'snapshot':
      content = JSON.stringify(snapshot, null, 2);
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

// ─── dlq ────────────────────────────────────────────────────────────────────

async function runDlq(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help') {
    console.log(`
  dlq list [entity-type]                List dead-lettered messages (counts or entries)
  dlq purge <entity-type> [--before <ts>]  Purge dead-letter entries
  dlq replay <entity-type> [--id <id>] [--all]  Publish replay request via Pub/Sub
    `);
    return;
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const prefixIdx = args.indexOf('--prefix');
  const keyPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'aq';
  const redis = new Redis(redisUrl);

  try {
    if (subcommand === 'list') {
      await dlqList(redis, keyPrefix, args.slice(1));
    } else if (subcommand === 'purge') {
      await dlqPurge(redis, keyPrefix, args.slice(1));
    } else if (subcommand === 'replay') {
      await dlqReplay(redis, keyPrefix, args.slice(1));
    } else {
      console.error(`Unknown dlq subcommand: ${subcommand}`);
      process.exit(1);
    }
  } finally {
    await redis.quit();
  }
}

async function dlqList(redis: Redis, keyPrefix: string, args: string[]): Promise<void> {
  const entityType = args.find((a) => !a.startsWith('--'));

  if (entityType) {
    const deadKey = `${keyPrefix}:dead:${entityType}`;
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 50;
    const entries = await redis.lrange(deadKey, 0, limit - 1);
    const total = await redis.llen(deadKey);

    if (entries.length === 0) {
      console.log(`No dead-letter entries for '${entityType}'.`);
      return;
    }

    console.log(
      `\n  Dead-letter queue: ${entityType}  (${total} total, showing ${entries.length})\n`,
    );
    for (const raw of entries) {
      const entry = JSON.parse(raw);
      const ts = new Date(entry.deadLetteredAt).toISOString();
      console.log(
        `  [${ts}]  ${entry.name}  entity=${entry.entityType}:${entry.entityId}  reason=${entry.deadLetterReason}`,
      );
    }
    console.log('');
    return;
  }

  const keys = await scanKeys(redis, `${keyPrefix}:dead:*`);
  if (keys.length === 0) {
    console.log('No dead-letter queues found.');
    return;
  }

  console.log(`\n  Dead-letter queues  (prefix: ${keyPrefix})\n`);
  for (const key of keys) {
    const entityName = key.replace(`${keyPrefix}:dead:`, '');
    const count = await redis.llen(key);
    console.log(`  ${entityName}: ${count} entries`);
  }
  console.log('');
}

async function dlqPurge(redis: Redis, keyPrefix: string, args: string[]): Promise<void> {
  const entityType = args.find((a) => !a.startsWith('--'));
  if (!entityType) {
    console.error('Usage: dlq purge <entity-type> [--before <timestamp-ms>]');
    process.exit(1);
  }

  const deadKey = `${keyPrefix}:dead:${entityType}`;
  const beforeIdx = args.indexOf('--before');

  if (beforeIdx >= 0) {
    const beforeTs = parseInt(args[beforeIdx + 1], 10);
    const entries = await redis.lrange(deadKey, 0, -1);
    let purged = 0;
    for (const raw of entries) {
      const entry = JSON.parse(raw);
      if (entry.deadLetteredAt < beforeTs) {
        await redis.lrem(deadKey, 1, raw);
        purged++;
      }
    }
    console.log(
      `Purged ${purged} entries from ${entityType} DLQ (before ${new Date(beforeTs).toISOString()}).`,
    );
  } else {
    const count = await redis.llen(deadKey);
    await redis.del(deadKey);
    console.log(`Purged all ${count} entries from ${entityType} DLQ.`);
  }
}

async function dlqReplay(redis: Redis, keyPrefix: string, args: string[]): Promise<void> {
  const entityType = args.find((a) => !a.startsWith('--'));
  if (!entityType) {
    console.error('Usage: dlq replay <entity-type> [--id <message-id>] [--all]');
    process.exit(1);
  }

  const idIdx = args.indexOf('--id');
  const replayAll = args.includes('--all');
  const channel = `${keyPrefix}:dlq:replay`;

  if (idIdx >= 0) {
    const messageId = args[idIdx + 1];
    const payload = JSON.stringify({ entityType, messageId });
    await redis.publish(channel, payload);
    console.log(`Published replay request for message ${messageId} on ${entityType}.`);
  } else if (replayAll) {
    const deadKey = `${keyPrefix}:dead:${entityType}`;
    const entries = await redis.lrange(deadKey, 0, -1);
    if (entries.length === 0) {
      console.log(`No dead-letter entries for '${entityType}'.`);
      return;
    }
    for (const raw of entries) {
      const entry = JSON.parse(raw);
      const payload = JSON.stringify({ entityType, messageId: entry.id, message: entry });
      await redis.publish(channel, payload);
    }
    console.log(`Published ${entries.length} replay requests for ${entityType}.`);
  } else {
    console.error('Specify --id <message-id> or --all');
    process.exit(1);
  }
}

// ─── shared ──────────────────────────────────────────────────────────────────

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== '0');
  return keys;
}

async function fetchSnapshot(redis: Redis, keyPrefix: string): Promise<RegistrySnapshot> {
  const keys = await scanKeys(redis, `${keyPrefix}:registry:*`);

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

Commands:
  introspect [entity-type]                                Inspect live registry contracts
  generate --classes [-o <dir>]                           Generate decorated TypeScript classes (recommended)
  generate --ts [--output <path>]                         Generate TypeScript interfaces + DispatchMap
  generate --json-schema [--output <path>]                Generate JSON Schema
  generate --snapshot [--output <path>]                   Export full registry snapshot
  dlq list [entity-type]                                  List dead-letter queues or entries
  dlq purge <entity-type> [--before <ts>]                 Purge dead-letter entries
  dlq replay <entity-type> [--id <id>] [--all]            Publish replay request via Pub/Sub

Options:
  --output, -o <path>  Output directory (--classes) or file (other formats)
  --prefix <prefix>    Redis key prefix (default: 'aq')
  --entities <list>    Comma-separated entity types to include

Environment:
  REDIS_URL            Redis connection URL (default: redis://localhost:6379)

Examples:
  npx atomic-queues introspect
  npx atomic-queues introspect account
  npx atomic-queues generate --classes -o src/generated
  npx atomic-queues generate --classes -o src/generated --entities warehouse,billing
  npx atomic-queues generate --ts --output ./generated/contracts.ts
  npx atomic-queues dlq list
  npx atomic-queues dlq list warehouse
  npx atomic-queues dlq purge warehouse --before 1714000000000
  npx atomic-queues dlq replay warehouse --all

Usage (after --classes):
  import { ReserveStockCommand, GetStockQuery } from './generated/warehouse';

  await queueBus.enqueue(new ReserveStockCommand({ sku: 'SKU-001', quantity: 50 }));
  const stock = await queueBus.enqueueAndWait(new GetStockQuery({ sku: 'SKU-001' }));
  // stock.available — fully typed, no timeout, no string API
  `);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
