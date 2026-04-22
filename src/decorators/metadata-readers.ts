import {
  ENTITY_TYPE_METADATA,
  ENTITY_ID_METADATA,
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
  ACTOR_METADATA,
  ACTOR_HANDLERS_METADATA,
} from './constants';
import {
  JobCommandMetadata,
  JobQueryMetadata,
  ActorOptions,
  ActorHandlerMetadata,
} from './interfaces';

export function getEntityType(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_TYPE_METADATA, target);
}

export function getEntityIdProperty(target: Function): string | undefined {
  return Reflect.getMetadata(ENTITY_ID_METADATA, target);
}

export function getJobCommandMetadata(target: Function): JobCommandMetadata | undefined {
  return Reflect.getMetadata(JOB_COMMAND_METADATA, target);
}

export function getJobQueryMetadata(target: Function): JobQueryMetadata | undefined {
  return Reflect.getMetadata(JOB_QUERY_METADATA, target);
}

export function getActorMetadata(target: Function): ActorOptions | undefined {
  return Reflect.getMetadata(ACTOR_METADATA, target);
}

export function getActorHandlers(target: Function): ActorHandlerMetadata[] {
  return Reflect.getMetadata(ACTOR_HANDLERS_METADATA, target) || [];
}
