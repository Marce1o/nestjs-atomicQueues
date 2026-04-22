#!/usr/bin/env node

import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { generateTypeScript } from './generators/typescript';
import { generateJsonSchema } from './generators/json-schema';
import { generateClasses } from './generators/classes';
import { RegistrySnapshot, EntityContract } from '../services/registry/registry.types';

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

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

// ─── introspect ──────────────────────────────────────────────────────────────

async function runIntrospect(args: string[]): Promise<void> {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const prefixIdx = args.indexOf('--prefix');
  const keyPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'aq';
  const entityFilter = args.find(a => !a.startsWith('--'));

  const redis = new Redis(redisUrl);
  const snapshot = await fetchSnapshot(redis, keyPrefix);
  await redis.quit();

  if (snapshot.entities.length === 0) {
    console.log('No entity types found in the registry.');
    console.log('Is the registry enabled and are services running?');
    process.exit(0);
  }

  const entities = entityFilter
    ? snapshot.entities.filter(e => e.entityType === entityFilter)
    : snapshot.entities;

  if (entityFilter && entities.length === 0) {
    console.error(`Entity type '${entityFilter}' not found in the registry.`);
    console.log(`Available: ${snapshot.entities.map(e => e.entityType).join(', ')}`);
    process.exit(1);
  }

  console.log('');
  console.log(`  Cluster Registry  (prefix: ${keyPrefix}, ${snapshot.entities.length} entity types)`);
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
    console.log(`    await queueBus.enqueue('${first.entityType}', '${name}', entityId, ${exampleData});`);
  }
  console.log('');
}

function formatFields(spec: { schema?: Record<string, any> }): string[] {
  if (!spec.schema?.properties) return [];
  return formatSchemaFields(spec.schema);
}

function formatSchemaFields(schema: Record<string, any>): string[] {
  if (!schema.properties) return [];
  const required = new Set<string>(schema.required ?? []);

  return Object.entries(schema.properties).map(([name, propSchema]) => {
    const type = jsonSchemaTypeLabel(propSchema as any);
    const opt = required.has(name) ? '' : '?';
    return `${name}${opt}: ${type}`;
  });
}

function jsonSchemaTypeLabel(schema: { type?: string; items?: any; enum?: any[] }): string {
  if (!schema.type) return 'any';
  switch (schema.type) {
    case 'string': return schema.enum ? schema.enum.map((v: any) => `"${v}"`).join(' | ') : 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return schema.items ? `${jsonSchemaTypeLabel(schema.items)}[]` : 'any[]';
    case 'object': return 'object';
    case 'null': return 'null';
    default: return 'any';
  }
}

function buildExampleData(spec: { schema?: Record<string, any> }): string {
  if (!spec.schema?.properties) return '{ ... }';
  const entries = Object.entries(spec.schema.properties).map(([name, propSchema]) => {
    const type = (propSchema as any).type;
    const example = type === 'string' ? `'...'`
      : type === 'number' || type === 'integer' ? '0'
      : type === 'boolean' ? 'true'
      : '...';
    return `${name}: ${example}`;
  });
  return `{ ${entries.join(', ')} }`;
}

// ─── generate ────────────────────────────────────────────────────────────────

async function runGenerate(args: string[]): Promise<void> {
  const format = args.includes('--classes') ? 'classes'
    : args.includes('--ts') ? 'ts'
    : args.includes('--json-schema') ? 'json-schema'
    : args.includes('--snapshot') ? 'snapshot'
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
    console.error('No entity types found in the registry. Is the registry enabled and are services running?');
    process.exit(1);
  }

  if (entitiesFilter) {
    snapshot.entities = snapshot.entities.filter(e => entitiesFilter.includes(e.entityType));
    if (snapshot.entities.length === 0) {
      console.error(`No matching entity types. Available: ${snapshot.entities.map(e => e.entityType).join(', ')}`);
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

// ─── shared ──────────────────────────────────────────────────────────────────

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

Commands:
  introspect [entity-type]                                Inspect live registry contracts
  generate --classes [-o <dir>]                           Generate decorated TypeScript classes (recommended)
  generate --ts [--output <path>]                         Generate TypeScript interfaces + DispatchMap
  generate --json-schema [--output <path>]                Generate JSON Schema
  generate --snapshot [--output <path>]                   Export full registry snapshot

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

Usage (after --classes):
  import { ReserveStockCommand, GetStockQuery } from './generated/warehouse';

  await queueBus.enqueue(new ReserveStockCommand({ sku: 'SKU-001', quantity: 50 }));
  const stock = await queueBus.enqueueAndWait(new GetStockQuery({ sku: 'SKU-001' }));
  // stock.available — fully typed, no timeout, no string API
  `);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
