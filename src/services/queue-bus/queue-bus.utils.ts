import { Logger } from '@nestjs/common';
import { getEntityIdProperty } from '../../decorators';
import { IEntityConfig } from '../../domain/interfaces';

/**
 * Derive job name from class name
 * MakeBetCommand -> MakeBetCommand (keep as-is for lookup)
 */
export function getJobName(commandOrQuery: object): string {
  return commandOrQuery.constructor.name;
}

/**
 * Extract all properties from a command/query instance
 */
export function extractData(commandOrQuery: object): Record<string, any> {
  const data: Record<string, any> = {};

  // Get all enumerable properties
  for (const key of Object.keys(commandOrQuery)) {
    data[key] = (commandOrQuery as any)[key];
  }

  return data;
}

/**
 * Extract entityId from command using explicit decorators and config.
 *
 * Priority chain (highest to lowest):
 * 1. @QueueEntityId() decorator on command property
 * 2. processorDefaultEntityId from @WorkerProcessor({ defaultEntityId })
 * 3. entityConfig.defaultEntityId from module entities config
 * 4. Throws error (no magic fallback)
 *
 * @param commandOrQuery - The command/query instance
 * @param data - Extracted data from command
 * @param processorDefaultEntityId - Default from @WorkerProcessor
 * @param entityConfig - Config from module entities
 * @param logger - Optional logger for debug info
 */
export function extractEntityIdExplicit(
  commandOrQuery: object,
  data: Record<string, any>,
  processorDefaultEntityId?: string,
  entityConfig?: IEntityConfig,
  logger?: Logger,
): string {
  const className = commandOrQuery.constructor.name;

  // 1. Check for @QueueEntityId() decorator on the command class
  const decoratedProperty = getEntityIdProperty(commandOrQuery.constructor);
  if (decoratedProperty && data[decoratedProperty] !== undefined) {
    logger?.debug(
      `[${className}] Using @QueueEntityId() decorated property: ${decoratedProperty}`,
    );
    return String(data[decoratedProperty]);
  }

  // 2. Check processor-level default
  if (processorDefaultEntityId && data[processorDefaultEntityId] !== undefined) {
    logger?.debug(
      `[${className}] Using processor defaultEntityId: ${processorDefaultEntityId}`,
    );
    return String(data[processorDefaultEntityId]);
  }

  // 3. Check entity config default
  if (entityConfig?.defaultEntityId && data[entityConfig.defaultEntityId] !== undefined) {
    logger?.debug(
      `[${className}] Using entity config defaultEntityId: ${entityConfig.defaultEntityId}`,
    );
    return String(data[entityConfig.defaultEntityId]);
  }

  // 4. No fallback - throw error with helpful message
  const availableKeys = Object.keys(data).join(', ');
  throw new Error(
    `Cannot extract entityId from ${className}. ` +
    `Use @QueueEntityId() decorator on the ID property, ` +
    `or set defaultEntityId in @WorkerProcessor or module entities config. ` +
    `Available properties: [${availableKeys}]`,
  );
}

/**
 * Legacy extract entityId from command data
 * Tries common property names in order
 * @deprecated Use extractEntityIdExplicit instead
 */
export function extractEntityId(data: Record<string, any>, logger?: Logger): string {
  const candidates = ['entityId', 'tableId', 'userId', 'id', 'gameId', 'playerId'];

  for (const key of candidates) {
    if (data[key] !== undefined && data[key] !== null) {
      return String(data[key]);
    }
  }

  // Log warning if no entityId found
  logger?.warn(
    `Could not extract entityId from command data. Keys: ${Object.keys(data).join(', ')}`,
  );

  return 'default';
}
