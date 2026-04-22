import { Logger } from '@nestjs/common';

const logger = new Logger('SchemaConverter');

let zodToJsonSchema: ((schema: any) => any) | null = null;

try {
  const mod = require('zod-to-json-schema');
  zodToJsonSchema = mod.zodToJsonSchema || mod.default?.zodToJsonSchema || mod.default;
} catch {
  // zod-to-json-schema not installed
}

export function convertZodToJsonSchema(zodSchema: any): Record<string, any> | undefined {
  if (!zodToJsonSchema) {
    logger.debug('zod-to-json-schema not available — schema will not be serialized');
    return undefined;
  }

  try {
    return zodToJsonSchema(zodSchema) as Record<string, any>;
  } catch (err) {
    logger.warn(`Failed to convert Zod schema: ${(err as Error).message}`);
    return undefined;
  }
}
