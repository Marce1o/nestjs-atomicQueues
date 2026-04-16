// Registry to track @QueueEntityId usage per class (for duplicate detection)
export const queueEntityIdRegistry = new Map<Function, string>();
