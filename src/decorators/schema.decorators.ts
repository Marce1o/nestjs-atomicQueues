import { SCHEMA_METADATA, REPLY_SCHEMA_METADATA } from './constants';

export function Schema(zodSchema: unknown, replySchema?: unknown): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(SCHEMA_METADATA, zodSchema, target);
    if (replySchema) {
      Reflect.defineMetadata(REPLY_SCHEMA_METADATA, replySchema, target);
    }
  };
}
