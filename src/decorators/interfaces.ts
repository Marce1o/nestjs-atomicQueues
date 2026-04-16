import { Type } from '@nestjs/common';
import { IWorkerConfig } from '../domain';

// =============================================================================
// DECORATOR OPTION INTERFACES
// =============================================================================

/**
 * Options for @WorkerProcessor decorator
 */
export interface WorkerProcessorOptions {
  /** Entity type this processor handles (e.g., 'table', 'user') */
  entityType: string;
  /** Default property name for entity ID extraction (optional) */
  defaultEntityId?: string;
  /** Function to generate queue name from entityId */
  queueName?: string | ((entityId: string) => string);
  /** Function to generate worker name from entityId */
  workerName?: string | ((entityId: string) => string);
  /** Worker configuration */
  workerConfig?: IWorkerConfig;
  /**
   * If true, workerConfig fully replaces module workerDefaults (no merge).
   * If false (default), workerConfig is merged with workerDefaults.
   */
  overrideDefaults?: boolean;
  /**
   * Maximum workers per entity (default: 1).
   * Used when operating without an EntityScaler.
   */
  maxWorkersPerEntity?: number;
  /**
   * Idle timeout in seconds before a worker is considered idle and can be terminated.
   * Workers self-report idle time via heartbeat. Default: 15 seconds.
   * Used when operating without an EntityScaler.
   */
  idleTimeoutSeconds?: number;
  /**
   * If true, workers are automatically spawned when jobs arrive (scalerless mode).
   * When enabled, no @EntityScaler is required - workers spawn on job arrival
   * and terminate when idle. Default: true if no EntityScaler is registered.
   */
  autoSpawn?: boolean;
}

/**
 * Options for @EntityScaler decorator
 */
export interface EntityScalerOptions {
  /** Entity type this scaler handles */
  entityType: string;
  /** Maximum workers per entity */
  maxWorkersPerEntity?: number;
  /**
   * Idle timeout in seconds before a worker is considered idle and can be terminated.
   * Workers self-report idle time via heartbeat. Default: 15 seconds.
   */
  idleTimeoutSeconds?: number;
}

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
 * Stored job handler metadata
 */
export interface JobHandlerMetadata {
  jobName: string;
  methodName: string;
  isWildcard: boolean;
}

/**
 * Stored worker processor metadata
 */
export interface WorkerProcessorMetadata {
  entityType: string;
  defaultEntityId?: string;
  queueNameFn: (entityId: string) => string;
  workerNameFn: (entityId: string) => string;
  workerConfig: IWorkerConfig;
  overrideDefaults: boolean;
  targetClass: Type<any>;
  jobHandlers: Map<string, JobHandlerMetadata>;
  wildcardHandler?: JobHandlerMetadata;
}

/**
 * Stored entity scaler metadata
 */
export interface EntityScalerMetadata {
  entityType: string;
  maxWorkersPerEntity: number;
  targetClass: Type<any>;
  getActiveEntitiesMethod?: string;
  getDesiredWorkerCountMethod?: string;
  onSpawnWorkerMethod?: string;
  onTerminateWorkerMethod?: string;
}
