import { Injectable, Logger, Type, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { ISerializedMessage, ICommandBus, IQueryBus } from '../../domain';
import { getConstructorParamNames } from '../../decorators/utils';
import { discoverCqrsClasses } from '../../utils';
import { CommandDiscoveryService } from '../command-discovery';

interface IActorEntry {
  create: () => Record<string, Function>;
  handlers: Map<string, string>;
}

@Injectable()
export class HandlerExecutor implements OnModuleInit {
  private readonly logger = new Logger(HandlerExecutor.name);

  private commandBus: ICommandBus | null = null;
  private queryBus: IQueryBus | null = null;

  private actorHandlerMap = new Map<string, IActorEntry>();
  private commandRegistry = new Map<string, { targetClass: Type<unknown>; isQuery: boolean }>();
  private commandDiscovery: CommandDiscoveryService | null = null;

  constructor(
    private readonly commandDiscoveryService: CommandDiscoveryService,
    private readonly discoveryService: DiscoveryService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    this.commandDiscovery = this.commandDiscoveryService;

    try {
      const { CommandBus, QueryBus } = await import('@nestjs/cqrs');
      try {
        const commandBus = this.moduleRef.get(CommandBus, { strict: false });
        if (commandBus) {
          this.commandBus = commandBus;
          this.commandDiscoveryService.setCommandBus(commandBus);
        }
      } catch {}
      try {
        const queryBus = this.moduleRef.get(QueryBus, { strict: false });
        if (queryBus) {
          this.queryBus = queryBus;
          this.commandDiscoveryService.setQueryBus(queryBus);
        }
      } catch {}
    } catch {
      this.logger.debug('@nestjs/cqrs not available — CQRS auto-wiring skipped');
    }

    this.discoverCqrsHandlers();
  }

  private discoverCqrsHandlers(): void {
    const providers = this.discoveryService.getProviders();
    const { commands, queries } = discoverCqrsClasses(providers);

    for (const [name, cls] of commands) {
      if (!this.commandRegistry.has(name)) {
        this.registerCommand(name, cls as Type<unknown>, false);
      }
    }
    for (const [name, cls] of queries) {
      if (!this.commandRegistry.has(name)) {
        this.registerCommand(name, cls as Type<unknown>, true);
      }
    }

    if (commands.size > 0 || queries.size > 0) {
      this.logger.log(`Auto-discovered ${commands.size} CQRS commands and ${queries.size} queries`);
    }
  }

  setCommandBus(bus: ICommandBus): void {
    this.commandBus = bus;
  }

  setQueryBus(bus: IQueryBus): void {
    this.queryBus = bus;
  }

  setCommandDiscovery(discovery: CommandDiscoveryService): void {
    this.commandDiscovery = discovery;
  }

  registerActor(
    entityType: string,
    actorInstance: Record<string, Function>,
    handlers: Map<string, string>,
  ): void {
    this.actorHandlerMap.set(entityType, {
      create: () => actorInstance,
      handlers,
    });
  }

  registerCommand(className: string, targetClass: Type<unknown>, isQuery: boolean): void {
    this.commandRegistry.set(className, { targetClass, isQuery });
  }

  canHandle(entityType: string, messageName: string): boolean {
    const actorEntry = this.actorHandlerMap.get(entityType);
    if (actorEntry && actorEntry.handlers.has(messageName)) return true;

    if (this.commandDiscovery?.hasHandler(messageName, entityType)) return true;

    if (this.commandRegistry.has(messageName)) return true;

    return false;
  }

  async execute(message: ISerializedMessage, entityKey: string): Promise<unknown> {
    const { name, data, entityType, entityId } = message;

    const actorEntry = this.actorHandlerMap.get(entityType);
    if (actorEntry) {
      const methodName = actorEntry.handlers.get(name);
      if (methodName) {
        const actor = actorEntry.create();
        const msgInstance = { ...data };
        return actor[methodName](msgInstance);
      }
    }

    if (this.commandDiscovery) {
      const fakeJob = { name, data, id: message.id };
      const result = await this.commandDiscovery.executeJob(fakeJob, entityId, entityType);
      if (result !== undefined || this.commandDiscovery.hasHandler(name, entityType)) {
        return result;
      }
    }

    const registryEntry = this.commandRegistry.get(name);
    if (registryEntry) {
      const { targetClass, isQuery } = registryEntry;
      const Ctor = targetClass as new (...args: unknown[]) => Record<string, unknown>;
      const paramNames = this.getParamNames(Ctor);
      const args = paramNames.length > 0
        ? paramNames.map(p => (data as Record<string, unknown>)[p])
        : [];
      const instance = args.length > 0 ? new Ctor(...args) : Object.assign(new Ctor(), data);

      if (isQuery) {
        if (!this.queryBus) {
          this.logger.error(`QueryBus not set. Cannot execute query ${name}.`);
          return null;
        }
        return this.queryBus.execute(instance);
      } else {
        if (!this.commandBus) {
          this.logger.error(`CommandBus not set. Cannot execute command ${name}.`);
          return null;
        }
        return this.commandBus.execute(instance);
      }
    }

    this.logger.warn(`No handler found for message '${name}' on entity type '${entityType}'`);
    return null;
  }

  private getParamNames(ctor: Function): string[] {
    return getConstructorParamNames(ctor);
  }
}
