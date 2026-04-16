export const DEFAULT_KEY_PREFIX = 'aq';

export function resolveKeyPrefix(config: { keyPrefix?: string }): string {
  return config.keyPrefix || DEFAULT_KEY_PREFIX;
}

/**
 * Generate a queue name for an entity.
 */
export function getEntityQueueName(
  entityType: string,
  entityId: string,
  prefix = 'aq',
): string {
  return `${prefix}:${entityType}:${entityId}:queue`;
}

/**
 * Generate a worker name for an entity.
 */
export function getEntityWorkerName(
  entityType: string,
  entityId: string,
  prefix = 'aq',
): string {
  return `${prefix}:${entityType}:${entityId}:worker`;
}

/**
 * Parse a queue name to extract entity info.
 */
export function parseQueueName(queueName: string): {
  prefix: string;
  entityType: string;
  entityId: string;
} | null {
  const parts = queueName.split(':');
  if (parts.length >= 4 && parts[3] === 'queue') {
    return {
      prefix: parts[0],
      entityType: parts[1],
      entityId: parts[2],
    };
  }
  return null;
}
