import { Type } from '@nestjs/common';

const COMMAND_HANDLER_METADATA = '__commandHandler__';
const QUERY_HANDLER_METADATA = '__queryHandler__';

export interface CqrsDiscoveryResult {
  commands: Map<string, Type<unknown>>;
  queries: Map<string, Type<unknown>>;
}

export function discoverCqrsClasses(
  providers: { metatype?: Function | null }[],
): CqrsDiscoveryResult {
  const commands = new Map<string, Type<unknown>>();
  const queries = new Map<string, Type<unknown>>();

  for (const wrapper of providers) {
    const { metatype } = wrapper;
    if (!metatype) continue;

    const commandClass = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);
    if (commandClass && typeof commandClass === 'function') {
      if (!commands.has(commandClass.name)) {
        commands.set(commandClass.name, commandClass);
      }
    }

    const queryClass = Reflect.getMetadata(QUERY_HANDLER_METADATA, metatype);
    if (queryClass && typeof queryClass === 'function') {
      if (!queries.has(queryClass.name)) {
        queries.set(queryClass.name, queryClass);
      }
    }
  }

  return { commands, queries };
}
