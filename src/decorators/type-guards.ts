import { Type } from '@nestjs/common';
import {
  WORKER_PROCESSOR_METADATA,
  ENTITY_SCALER_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
} from './constants';

/**
 * Check if a class is a WorkerProcessor
 */
export function isWorkerProcessor(target: Type<any>): boolean {
  return Reflect.hasMetadata(WORKER_PROCESSOR_METADATA, target);
}

/**
 * Check if a class is an EntityScaler
 */
export function isEntityScaler(target: Type<any>): boolean {
  return Reflect.hasMetadata(ENTITY_SCALER_METADATA, target);
}

/**
 * Check if a class is a JobCommand
 */
export function isJobCommand(target: Function): boolean {
  return Reflect.hasMetadata(JOB_COMMAND_METADATA, target);
}

/**
 * Check if a class is a JobQuery
 */
export function isJobQuery(target: Function): boolean {
  return Reflect.hasMetadata(JOB_QUERY_METADATA, target);
}
