import { Injectable, Logger, OnModuleInit, Type, Optional } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import {
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
  JobCommandMetadata,
  JobQueryMetadata,
} from '../../decorators';

interface ICommandBus {
  execute<T>(command: T): Promise<any>;
}

interface IQueryBus {
  execute<T>(query: T): Promise<any>;
}

interface IJobLike {
  name: string;
  data: Record<string, any>;
  id: string;
}

@Injectable()
export class CommandDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(CommandDiscoveryService.name);

  private readonly commandMap = new Map<string, JobCommandMetadata>();
  private readonly queryMap = new Map<string, JobQueryMetadata>();
  private readonly scopedCommandMap = new Map<string, JobCommandMetadata>();
  private readonly scopedQueryMap = new Map<string, JobQueryMetadata>();

  private commandBus: ICommandBus | null = null;
  private queryBus: IQueryBus | null = null;

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService,
    @Optional() private readonly reflector: Reflector,
  ) {}

  setCommandBus(commandBus: ICommandBus): void {
    this.commandBus = commandBus;
  }

  setQueryBus(queryBus: IQueryBus): void {
    this.queryBus = queryBus;
  }

  async onModuleInit(): Promise<void> {
    if (!this.discoveryService) {
      this.logger.warn(
        'DiscoveryService not available. @JobCommand/@JobQuery auto-routing disabled.',
      );
      return;
    }

    this.discoverCommands();
    this.discoverQueries();

    if (this.commandMap.size > 0 || this.queryMap.size > 0) {
      this.logger.log(
        `Discovered ${this.commandMap.size} @JobCommand and ${this.queryMap.size} @JobQuery classes`,
      );
    }
  }

  private discoverCommands(): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const metadata = Reflect.getMetadata(JOB_COMMAND_METADATA, metatype) as
        | JobCommandMetadata
        | undefined;

      if (metadata) {
        this.commandMap.set(metadata.jobName, metadata);

        if (metadata.entityType) {
          const scopedKey = `${metadata.entityType}:${metadata.jobName}`;
          this.scopedCommandMap.set(scopedKey, metadata);
        }

        this.logger.debug(
          `Registered @JobCommand: ${metadata.jobName} -> ${metatype.name}`,
        );
      }
    }
  }

  private discoverQueries(): void {
    if (!this.discoveryService) return;

    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { metatype } = wrapper;
      if (!metatype) continue;

      const metadata = Reflect.getMetadata(JOB_QUERY_METADATA, metatype) as
        | JobQueryMetadata
        | undefined;

      if (metadata) {
        this.queryMap.set(metadata.jobName, metadata);

        if (metadata.entityType) {
          const scopedKey = `${metadata.entityType}:${metadata.jobName}`;
          this.scopedQueryMap.set(scopedKey, metadata);
        }

        this.logger.debug(
          `Registered @JobQuery: ${metadata.jobName} -> ${metatype.name}`,
        );
      }
    }
  }

  hasHandler(jobName: string, entityType?: string): boolean {
    if (entityType) {
      const scopedKey = `${entityType}:${jobName}`;
      if (this.scopedCommandMap.has(scopedKey) || this.scopedQueryMap.has(scopedKey)) {
        return true;
      }
    }
    return this.commandMap.has(jobName) || this.queryMap.has(jobName);
  }

  getCommandClass(jobName: string, entityType?: string): Type<any> | undefined {
    if (entityType) {
      const scopedKey = `${entityType}:${jobName}`;
      const scopedMeta = this.scopedCommandMap.get(scopedKey);
      if (scopedMeta) return scopedMeta.targetClass as Type<any>;
    }
    return this.commandMap.get(jobName)?.targetClass as Type<any> | undefined;
  }

  getQueryClass(jobName: string, entityType?: string): Type<any> | undefined {
    if (entityType) {
      const scopedKey = `${entityType}:${jobName}`;
      const scopedMeta = this.scopedQueryMap.get(scopedKey);
      if (scopedMeta) return scopedMeta.targetClass as Type<any>;
    }
    return this.queryMap.get(jobName)?.targetClass as Type<any> | undefined;
  }

  async executeJob(job: IJobLike, entityId: string, entityType?: string): Promise<any> {
    const jobName = job.name;

    let commandMeta: JobCommandMetadata | undefined;
    if (entityType) {
      commandMeta = this.scopedCommandMap.get(`${entityType}:${jobName}`);
    }
    if (!commandMeta) {
      commandMeta = this.commandMap.get(jobName);
    }

    if (commandMeta) {
      if (!this.commandBus) {
        throw new Error(
          'CommandBus not available. Ensure @nestjs/cqrs is installed and CqrsModule is imported.',
        );
      }
      const command = this.instantiateFromMetadata(commandMeta, entityId, job.data);
      this.logger.debug(
        `Executing command ${commandMeta.targetClass.name} for job ${jobName}`,
      );
      return this.commandBus.execute(command);
    }

    let queryMeta: JobQueryMetadata | undefined;
    if (entityType) {
      queryMeta = this.scopedQueryMap.get(`${entityType}:${jobName}`);
    }
    if (!queryMeta) {
      queryMeta = this.queryMap.get(jobName);
    }

    if (queryMeta) {
      if (!this.queryBus) {
        throw new Error(
          'QueryBus not available. Ensure @nestjs/cqrs is installed and CqrsModule is imported.',
        );
      }
      const query = this.instantiateFromMetadata(queryMeta, entityId, job.data);
      this.logger.debug(
        `Executing query ${queryMeta.targetClass.name} for job ${jobName}`,
      );
      return this.queryBus.execute(query);
    }

    return undefined;
  }

  private instantiateFromMetadata(
    metadata: JobCommandMetadata | JobQueryMetadata,
    entityId: string,
    jobData: Record<string, any>,
  ): any {
    const { targetClass, paramNames, entityIdParam } = metadata;

    const args: any[] = [];

    for (let i = 0; i < paramNames.length; i++) {
      const paramName = paramNames[i];

      const isEntityIdParam =
        (typeof entityIdParam === 'number' && i === entityIdParam) ||
        (typeof entityIdParam === 'string' && paramName === entityIdParam);

      if (isEntityIdParam) {
        args.push(entityId);
      } else {
        args.push(jobData[paramName]);
      }
    }

    return new (targetClass as Type<any>)(...args);
  }

  getRegisteredJobNames(): { commands: string[]; queries: string[] } {
    return {
      commands: Array.from(this.commandMap.keys()),
      queries: Array.from(this.queryMap.keys()),
    };
  }
}
