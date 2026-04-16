import { Type } from '@nestjs/common';
import {
  ENTITY_TYPE_METADATA,
  ENTITY_ID_METADATA,
  WORKER_PROCESSOR_METADATA,
  JOB_HANDLER_METADATA,
  ENTITY_SCALER_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
} from './constants';
import {
  WorkerProcessorOptions,
  JobHandlerMetadata,
  EntityScalerOptions,
  JobCommandMetadata,
  JobQueryMetadata,
} from './interfaces';

/**
 * Get the entity type from a command/query class decorated with @EntityType or @QueueEntity
 */
export function getEntityType(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_TYPE_METADATA, target);
}

/**
 * Get the entity ID property name from a class decorated with @QueueEntityId or @QueueEntity
 */
export function getEntityIdProperty(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_ID_METADATA, target);
}

/**
 * Get WorkerProcessor metadata from a class
 */
export function getWorkerProcessorMetadata(target: Type<any>): WorkerProcessorOptions | undefined {
  return Reflect.getMetadata(WORKER_PROCESSOR_METADATA, target);
}

/**
 * Get all JobHandler metadata from a class
 */
export function getJobHandlerMetadata(target: Type<any>): JobHandlerMetadata[] {
  return Reflect.getMetadata(JOB_HANDLER_METADATA, target) || [];
}

/**
 * Get EntityScaler metadata from a class
 */
export function getEntityScalerMetadata(target: Type<any>): EntityScalerOptions | undefined {
  return Reflect.getMetadata(ENTITY_SCALER_METADATA, target);
}

/**
 * Get JobCommand metadata from a class
 */
export function getJobCommandMetadata(target: Function): JobCommandMetadata | undefined {
  return Reflect.getMetadata(JOB_COMMAND_METADATA, target);
}

/**
 * Get JobQuery metadata from a class
 */
export function getJobQueryMetadata(target: Function): JobQueryMetadata | undefined {
  return Reflect.getMetadata(JOB_QUERY_METADATA, target);
}
