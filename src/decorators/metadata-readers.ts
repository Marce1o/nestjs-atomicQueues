import {
  ENTITY_TYPE_METADATA,
  ENTITY_ID_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
  SCHEMA_METADATA,
  REPLY_SCHEMA_METADATA,
} from './constants';
import { JobCommandMetadata, JobQueryMetadata } from './interfaces';

export function getEntityType(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_TYPE_METADATA, target);
}

export function getEntityIdProperty(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_ID_METADATA, target);
}

/** @deprecated Part of the deprecated `@JobCommand` API. */
export function getJobCommandMetadata(target: Function): JobCommandMetadata | undefined {
  return Reflect.getMetadata(JOB_COMMAND_METADATA, target);
}

/** @deprecated Part of the deprecated `@JobQuery` API. */
export function getJobQueryMetadata(target: Function): JobQueryMetadata | undefined {
  return Reflect.getMetadata(JOB_QUERY_METADATA, target);
}

export function getSchemaMetadata(target: Function): unknown | undefined {
  return Reflect.getMetadata(SCHEMA_METADATA, target);
}

export function getReplySchemaMetadata(target: Function): unknown | undefined {
  return Reflect.getMetadata(REPLY_SCHEMA_METADATA, target);
}
