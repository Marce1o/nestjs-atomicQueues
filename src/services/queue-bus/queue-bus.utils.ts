import { Logger } from '@nestjs/common';
import { getEntityIdProperty } from '../../decorators';
import { IEntityConfig } from '../../domain/interfaces';

export function getJobName(commandOrQuery: object): string {
  return commandOrQuery.constructor.name;
}

export function extractData(commandOrQuery: object): Record<string, any> {
  const data: Record<string, any> = {};

  for (const key of Object.keys(commandOrQuery)) {
    data[key] = (commandOrQuery as any)[key];
  }

  return data;
}

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
    `or set defaultEntityId in module entities config. ` +
    `Available properties: [${availableKeys}]`,
  );
}
