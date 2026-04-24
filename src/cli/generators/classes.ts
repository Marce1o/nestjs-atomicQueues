import {
  RegistrySnapshot,
  EntityContract,
  MessageSpec,
} from '../../domain/interfaces/registry.types';

export interface GeneratedFile {
  filename: string;
  content: string;
}

/**
 * Generates instantiable TypeScript classes from the registry snapshot.
 * Each entity type gets its own file with decorated command/query classes
 * that work directly with `queueBus.enqueue()` and `queueBus.enqueueAndWait()`.
 */
export function generateClasses(snapshot: RegistrySnapshot): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const entity of snapshot.entities) {
    const filename = `${kebabCase(entity.entityType)}.ts`;
    const content = generateEntityFile(entity, snapshot);
    files.push({ filename, content });
  }

  // Barrel index
  const barrelLines: string[] = [header(snapshot), ''];
  for (const entity of snapshot.entities) {
    barrelLines.push(`export * from './${kebabCase(entity.entityType)}';`);
  }
  barrelLines.push('');
  files.push({ filename: 'index.ts', content: barrelLines.join('\n') });

  return files;
}

function generateEntityFile(entity: EntityContract, snapshot: RegistrySnapshot): string {
  const lines: string[] = [];
  const messages = Object.entries(entity.messages);
  const hasReply = messages.some(
    ([, spec]) => spec.kind === 'query' && spec.replySchema?.properties,
  );

  lines.push(header(snapshot));
  lines.push(`// Entity: ${entity.entityType} (service: ${entity.serviceName})`);
  lines.push('');

  // Imports
  const imports = ['EntityType'];
  const hasEntityId = messages.some(([, spec]) => spec.entityIdField);
  if (hasEntityId) imports.push('QueueEntityId');
  lines.push(`import { ${imports.join(', ')} } from 'atomic-queues';`);
  if (hasReply) {
    lines.push(`import type { Reply } from 'atomic-queues';`);
  }
  lines.push('');

  for (const [msgName, spec] of messages) {
    lines.push(generateMessage(entity.entityType, msgName, spec));
    lines.push('');
  }

  return lines.join('\n');
}

function generateMessage(entityType: string, msgName: string, spec: MessageSpec): string {
  const lines: string[] = [];
  const fields = extractFields(spec);
  const hasReplySchema = !!spec.replySchema?.properties;

  // Data interface
  const dataInterfaceName = `${msgName}Data`;
  lines.push(`export interface ${dataInterfaceName} {`);
  for (const field of fields) {
    lines.push(`  ${field.name}${field.required ? '' : '?'}: ${field.tsType};`);
  }
  lines.push('}');
  lines.push('');

  // Reply interface (for queries with reply schemas)
  if (hasReplySchema) {
    const replyFields = extractFieldsFromSchema(spec.replySchema!);
    const replyName = `${msgName}Reply`;
    lines.push(`export interface ${replyName} {`);
    for (const field of replyFields) {
      lines.push(`  ${field.name}${field.required ? '' : '?'}: ${field.tsType};`);
    }
    lines.push('}');
    lines.push('');
  }

  // Class
  const replyImpl = hasReplySchema ? ` implements Reply<${msgName}Reply>` : '';
  lines.push(`@EntityType('${entityType}')`);
  lines.push(`export class ${msgName}${replyImpl} {`);

  // Phantom reply brand (type-only)
  if (hasReplySchema) {
    lines.push(`  declare readonly __reply: ${msgName}Reply;`);
    lines.push('');
  }

  // Fields with @QueueEntityId on the entity ID field
  for (const field of fields) {
    if (field.name === spec.entityIdField) {
      lines.push(`  @QueueEntityId() readonly ${field.name}!: ${field.tsType};`);
    } else {
      lines.push(`  readonly ${field.name}${field.required ? '!' : '?'}: ${field.tsType};`);
    }
  }

  // Constructor
  lines.push('');
  lines.push(`  constructor(data: ${dataInterfaceName}) {`);
  lines.push('    Object.assign(this, data);');
  lines.push('  }');

  lines.push('}');

  return lines.join('\n');
}

interface FieldInfo {
  name: string;
  tsType: string;
  required: boolean;
}

function extractFields(spec: MessageSpec): FieldInfo[] {
  return extractFieldsFromSchema(spec.schema);
}

function extractFieldsFromSchema(schema?: Record<string, any>): FieldInfo[] {
  if (!schema?.properties) return [];
  const required = new Set<string>(schema.required ?? []);

  return Object.entries(schema.properties).map(([name, propSchema]) => ({
    name,
    tsType: jsonSchemaTypeToTS(propSchema as any),
    required: required.has(name),
  }));
}

function jsonSchemaTypeToTS(schema: { type?: string; items?: any; enum?: any[] }): string {
  if (!schema.type) return 'any';
  switch (schema.type) {
    case 'string':
      return schema.enum ? schema.enum.map((v: any) => `'${v}'`).join(' | ') : 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return schema.items ? `${jsonSchemaTypeToTS(schema.items)}[]` : 'any[]';
    case 'object':
      return 'Record<string, any>';
    case 'null':
      return 'null';
    default:
      return 'any';
  }
}

function header(snapshot: RegistrySnapshot): string {
  return [
    '// Auto-generated by atomic-queues — do not edit',
    `// Source: Redis registry (prefix: '${snapshot.keyPrefix}')`,
    `// Generated: ${new Date(snapshot.generatedAt).toISOString()}`,
    '// Regenerate: npx atomic-queues generate --classes',
  ].join('\n');
}

function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}
