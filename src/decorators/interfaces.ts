/**
 * @deprecated `@JobCommand` is deprecated. Use `@EntityType` + `@QueueEntityId` with `@CommandHandler`.
 */
export interface JobCommandOptions {
  /** Job name (defaults to kebab-case of class name without 'Command' suffix) */
  name?: string;
  /** Entity type this command belongs to (optional, for scoped routing) */
  entityType?: string;
  /** Which constructor parameter is the entityId (default: 0 = first param) */
  entityIdParam?: number | string;
  /** Explicit parameter names — use when builds minify constructor argument names */
  params?: string[];
}

/**
 * @deprecated `@JobQuery` is deprecated. Use `@EntityType` + `@QueueEntityId` with `@QueryHandler`.
 */
export interface JobQueryOptions {
  /** Job name (defaults to kebab-case of class name without 'Query' suffix) */
  name?: string;
  /** Entity type this query belongs to (optional, for scoped routing) */
  entityType?: string;
  /** Which constructor parameter is the entityId (default: 0 = first param) */
  entityIdParam?: number | string;
  /** Explicit parameter names — use when builds minify constructor argument names */
  params?: string[];
}

/** @deprecated Part of the deprecated `@JobCommand` API. */
export interface JobCommandMetadata {
  jobName: string;
  entityType?: string;
  entityIdParam: number | string;
  targetClass: Function;
  paramNames: string[];
}

/** @deprecated Part of the deprecated `@JobQuery` API. */
export interface JobQueryMetadata {
  jobName: string;
  entityType?: string;
  entityIdParam: number | string;
  targetClass: Function;
  paramNames: string[];
}

/**
 * Options for @Schema decorator
 */
export interface SchemaDecoratorOptions {
  /** The Zod schema for the message payload */
  schema: unknown;
  /** Optional reply schema (for queries) */
  replySchema?: unknown;
}
