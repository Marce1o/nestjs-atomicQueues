import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { getEntityType, getJobCommandMetadata, getJobQueryMetadata } from '../../decorators';

const COMMAND_HANDLER_METADATA = '__commandHandler__';
const QUERY_HANDLER_METADATA = '__queryHandler__';

@Injectable()
export class EntityTypeRegistry implements OnModuleInit {
  private readonly logger = new Logger(EntityTypeRegistry.name);
  private readonly entityTypes = new Set<string>();

  constructor(@Optional() private readonly discoveryService: DiscoveryService) {}

  async onModuleInit(): Promise<void> {
    this.discoverEntityTypes();
  }

  getRegisteredEntityTypes(): string[] {
    return Array.from(this.entityTypes);
  }

  hasEntityType(entityType: string): boolean {
    return this.entityTypes.has(entityType);
  }

  private discoverEntityTypes(): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const commandClass = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);
      if (commandClass && typeof commandClass === 'function') {
        const et = getEntityType(commandClass);
        if (et) this.entityTypes.add(et);
      }

      const queryClass = Reflect.getMetadata(QUERY_HANDLER_METADATA, metatype);
      if (queryClass && typeof queryClass === 'function') {
        const et = getEntityType(queryClass);
        if (et) this.entityTypes.add(et);
      }

      const cmdMeta = getJobCommandMetadata(metatype);
      if (cmdMeta?.entityType) this.entityTypes.add(cmdMeta.entityType);

      const queryMeta = getJobQueryMetadata(metatype);
      if (queryMeta?.entityType) this.entityTypes.add(queryMeta.entityType);
    }

    if (this.entityTypes.size > 0) {
      this.logger.log(`Discovered entity types: [${Array.from(this.entityTypes).join(', ')}]`);
    }
  }
}
