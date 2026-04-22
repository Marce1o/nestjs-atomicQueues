/**
 * Options for @JobCommand decorator
 */
export interface JobCommandOptions {
  /** Job name (defaults to kebab-case of class name without 'Command' suffix) */
  name?: string;
  /** Entity type this command belongs to (optional, for scoped routing) */
  entityType?: string;
  /** Which constructor parameter is the entityId (default: 0 = first param) */
  entityIdParam?: number | string;
}

/**
 * Options for @JobQuery decorator
 */
export interface JobQueryOptions {
  /** Job name (defaults to kebab-case of class name without 'Query' suffix) */
  name?: string;
  /** Entity type this query belongs to (optional, for scoped routing) */
  entityType?: string;
  /** Which constructor parameter is the entityId (default: 0 = first param) */
  entityIdParam?: number | string;
}

/**
 * Stored job command metadata
 */
export interface JobCommandMetadata {
  jobName: string;
  entityType?: string;
  entityIdParam: number | string;
  targetClass: Function;
  paramNames: string[];
}

/**
 * Stored job query metadata
 */
export interface JobQueryMetadata {
  jobName: string;
  entityType?: string;
  entityIdParam: number | string;
  targetClass: Function;
  paramNames: string[];
}

/**
 * Options for @Actor decorator
 */
export interface ActorOptions {
  /** Entity type this actor handles */
  entityType: string;
  /** Default property name for entity ID extraction */
  defaultEntityId?: string;
}

/**
 * Stored actor handler metadata
 */
export interface ActorHandlerMetadata {
  /** The message class this handler processes */
  messageClass: Function;
  /** The method name on the actor class */
  methodName: string;
}
