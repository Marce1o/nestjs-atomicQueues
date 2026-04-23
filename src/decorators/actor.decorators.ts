import { ACTOR_METADATA, ACTOR_HANDLER_METADATA, ACTOR_HANDLERS_METADATA } from './constants';
import { ActorOptions, ActorHandlerMetadata } from './interfaces';

export function Actor(
  entityType: string,
  options?: Partial<Omit<ActorOptions, 'entityType'>>,
): ClassDecorator {
  return (target: Function) => {
    const metadata: ActorOptions = {
      entityType,
      defaultEntityId: options?.defaultEntityId,
    };
    Reflect.defineMetadata(ACTOR_METADATA, metadata, target);

    if (!Reflect.hasMetadata('injectable', target)) {
      Reflect.defineMetadata('injectable', true, target);
    }
  };
}

export function On(messageClass: Function): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const methodName = String(propertyKey);

    const metadata: ActorHandlerMetadata = {
      messageClass,
      methodName,
    };

    Reflect.defineMetadata(ACTOR_HANDLER_METADATA, metadata, target, propertyKey);

    const existingHandlers: ActorHandlerMetadata[] =
      Reflect.getMetadata(ACTOR_HANDLERS_METADATA, target.constructor) || [];
    existingHandlers.push(metadata);
    Reflect.defineMetadata(ACTOR_HANDLERS_METADATA, existingHandlers, target.constructor);

    return descriptor;
  };
}
