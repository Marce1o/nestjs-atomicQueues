import { EntityContract, MessageSpec, RegistrySnapshot } from '../registry/registry.types';
import { IMessageRef } from '../../domain';

// ═══════════════════════════════════════════════════════════════════════════
// ClusterContracts — runtime introspection of the live registry
// ═══════════════════════════════════════════════════════════════════════════

export interface ContractMessage {
  name: string;
  kind: 'command' | 'query';
  schema?: Record<string, any>;
  replySchema?: Record<string, any>;
  fields: ContractField[];
}

export interface ContractField {
  name: string;
  type: string;
  required: boolean;
}

export interface ContractEntity {
  entityType: string;
  serviceName: string;
  version: string;
  messages: ContractMessage[];
}

export class ClusterContracts {
  private readonly entityMap: Map<string, EntityContract>;

  constructor(private readonly snapshot: RegistrySnapshot) {
    this.entityMap = new Map();
    for (const entity of snapshot.entities) {
      this.entityMap.set(entity.entityType, entity);
    }
  }

  /** All entity types registered in the cluster. */
  entityTypes(): string[] {
    return Array.from(this.entityMap.keys()).sort();
  }

  /** Whether an entity type exists in the registry. */
  hasEntity(entityType: string): boolean {
    return this.entityMap.has(entityType);
  }

  /** Get structured info about an entity type and its messages. */
  entity(entityType: string): ContractEntity | null {
    const contract = this.entityMap.get(entityType);
    if (!contract) return null;

    return {
      entityType: contract.entityType,
      serviceName: contract.serviceName,
      version: contract.version,
      messages: Object.entries(contract.messages).map(([name, spec]) => ({
        name,
        kind: spec.kind,
        schema: spec.schema,
        replySchema: spec.replySchema,
        fields: extractFields(spec),
      })),
    };
  }

  /** List all message names accepted by an entity type. */
  messagesFor(entityType: string): string[] {
    const contract = this.entityMap.get(entityType);
    if (!contract) return [];
    return Object.keys(contract.messages).sort();
  }

  /** Get the JSON Schema for a specific message. */
  schemaFor(entityType: string, messageName: string): Record<string, any> | null {
    const contract = this.entityMap.get(entityType);
    if (!contract) return null;
    return contract.messages[messageName]?.schema ?? null;
  }

  /** Get the reply schema for a query message. */
  replySchemaFor(entityType: string, messageName: string): Record<string, any> | null {
    const contract = this.entityMap.get(entityType);
    if (!contract) return null;
    return contract.messages[messageName]?.replySchema ?? null;
  }

  /** Whether a specific message is accepted by an entity type. */
  accepts(entityType: string, messageName: string): boolean {
    const contract = this.entityMap.get(entityType);
    if (!contract) return false;
    return messageName in contract.messages;
  }

  /** All entities with their messages as structured objects. */
  all(): ContractEntity[] {
    return this.entityTypes().map((et) => this.entity(et)!);
  }

  /** The raw snapshot from Redis. */
  raw(): RegistrySnapshot {
    return this.snapshot;
  }

  /** Human-readable summary for debugging / logging. */
  toString(): string {
    const lines: string[] = [];
    lines.push(`Cluster Registry (${this.entityMap.size} entity types)`);
    lines.push('');

    for (const entity of this.all()) {
      lines.push(`  ${entity.entityType}  (service: ${entity.serviceName})`);
      for (const msg of entity.messages) {
        const tag = msg.kind === 'query' ? 'query' : 'cmd';
        const fieldList =
          msg.fields.length > 0
            ? msg.fields.map((f) => `${f.name}${f.required ? '' : '?'}: ${f.type}`).join(', ')
            : 'untyped';
        lines.push(`    [${tag}] ${msg.name}({ ${fieldList} })`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

function extractFields(spec: MessageSpec): ContractField[] {
  if (!spec.schema?.properties) return [];

  const required = new Set<string>(spec.schema.required ?? []);

  return Object.entries(spec.schema.properties).map(([name, propSchema]) => ({
    name,
    type: jsonSchemaTypeLabel(propSchema as any),
    required: required.has(name),
  }));
}

function jsonSchemaTypeLabel(schema: { type?: string; items?: any; enum?: any[] }): string {
  if (!schema.type) return 'any';
  switch (schema.type) {
    case 'string':
      return schema.enum ? schema.enum.map((v: any) => `"${v}"`).join(' | ') : 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return schema.items ? `${jsonSchemaTypeLabel(schema.items)}[]` : 'any[]';
    case 'object':
      return 'object';
    case 'null':
      return 'null';
    default:
      return 'any';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TypedDispatch — compile-time type safety via generated DispatchMap
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Type-safe enqueue for cross-service communication using generated contracts.
 *
 * ```typescript
 * import { DispatchMap } from './generated/contracts';
 *
 * // Wrap once — full autocomplete on entity types, message names, and payloads
 * const enqueue = queueBus.enqueue.bind(queueBus) as TypedEnqueue<DispatchMap>;
 *
 * await enqueue('account', 'WithdrawCommand', accountId, {
 *   accountId: 'a-42',
 *   amount: 100,
 * });
 * ```
 */
export type TypedEnqueue<TMap> = <E extends keyof TMap & string, M extends keyof TMap[E] & string>(
  entityType: E,
  messageName: M,
  entityId: string,
  data: TMap[E][M],
) => Promise<IMessageRef>;

/**
 * Type-safe enqueueAndWait for cross-service communication.
 *
 * ```typescript
 * import { DispatchMap, ReplyMap } from './generated/contracts';
 *
 * const query = queueBus.enqueueAndWait.bind(queueBus) as TypedEnqueueAndWait<DispatchMap, ReplyMap>;
 *
 * const balance = await query('account', 'GetBalanceQuery', accountId, {
 *   accountId: 'a-42',
 * });
 * // balance is typed as ReplyMap['account']['GetBalanceQuery']
 * ```
 */
export type TypedEnqueueAndWait<TMap, TReplyMap = Record<string, Record<string, any>>> = <
  E extends keyof TMap & string,
  M extends keyof TMap[E] & string,
>(
  entityType: E,
  messageName: M,
  entityId: string,
  data: TMap[E][M],
  timeout?: number,
) => Promise<
  E extends keyof TReplyMap ? (M extends keyof TReplyMap[E] ? TReplyMap[E][M] : any) : any
>;
