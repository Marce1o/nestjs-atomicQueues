import { Injectable, Logger, OnModuleInit, Type, Optional } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Job } from 'bullmq';
import {
  JOB_COMMAND_METADATA,
  JOB_QUERY_METADATA,
  JobCommandMetadata,
  JobQueryMetadata,
} from '../../decorators';

// Import CQRS types but make them optional
interface ICommandBus {
  execute<T>(command: T): Promise<any>;
}

interface IQueryBus {
  execute<T>(query: T): Promise<any>;
}

/**
 * CommandDiscoveryService
 *
 * Discovers all classes decorated with @JobCommand and @JobQuery,
 * builds a routing map, and provides auto-execution capabilities.
 *
 * This eliminates the need for @JobHandler boilerplate - commands
 * decorated with @JobCommand are automatically routed and executed.
 */
@Injectable()
export class CommandDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(CommandDiscoveryService.name);

  /** Map of job name -> command metadata */
  private readonly commandMap = new Map<string, JobCommandMetadata>();

  /** Map of job name -> query metadata */
  private readonly queryMap = new Map<string, JobQueryMetadata>();

  /** Map of entityType:jobName -> command metadata (for scoped routing) */
  private readonly scopedCommandMap = new Map<string, JobCommandMetadata>();

  /** Map of entityType:jobName -> query metadata (for scoped routing) */
  private readonly scopedQueryMap = new Map<string, JobQueryMetadata>();

  private commandBus: ICommandBus | null = null;
  private queryBus: IQueryBus | null = null;

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService,
    @Optional() private readonly reflector: Reflector,
  ) {}

  /**
   * Set the CommandBus for executing commands
   * Called by the module setup if @nestjs/cqrs is available
   */
  setCommandBus(commandBus: ICommandBus): void {
    this.commandBus = commandBus;
  }

  /**
   * Set the QueryBus for executing queries
   * Called by the module setup if @nestjs/cqrs is available
   */
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

    this.logger.log(
      `Discovered ${this.commandMap.size} @JobCommand and ${this.queryMap.size} @JobQuery classes`,
    );
  }

  /**
   * Discover all @JobCommand decorated classes
   */
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

  /**
   * Discover all @JobQuery decorated classes
   */
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

  /**
   * Check if a job name has a registered command or query
   */
  hasHandler(jobName: string, entityType?: string): boolean {
    if (entityType) {
      const scopedKey = `${entityType}:${jobName}`;
      if (this.scopedCommandMap.has(scopedKey) || this.scopedQueryMap.has(scopedKey)) {
        return true;
      }
    }
    return this.commandMap.has(jobName) || this.queryMap.has(jobName);
  }

  /**
   * Get command class for a job name
   */
  getCommandClass(jobName: string, entityType?: string): Type<any> | undefined {
    if (entityType) {
      const scopedKey = `${entityType}:${jobName}`;
      const scopedMeta = this.scopedCommandMap.get(scopedKey);
      if (scopedMeta) return scopedMeta.targetClass as Type<any>;
    }
    return this.commandMap.get(jobName)?.targetClass as Type<any> | undefined;
  }

  /**
   * Get query class for a job name
   */
  getQueryClass(jobName: string, entityType?: string): Type<any> | undefined {
    if (entityType) {
      const scopedKey = `${entityType}:${jobName}`;
      const scopedMeta = this.scopedQueryMap.get(scopedKey);
      if (scopedMeta) return scopedMeta.targetClass as Type<any>;
    }
    return this.queryMap.get(jobName)?.targetClass as Type<any> | undefined;
  }

  /**
   * Execute a job by routing to the appropriate command or query
   *
   * @param job The BullMQ job
   * @param entityId The entity ID (injected by the worker processor)
   * @param entityType Optional entity type for scoped routing
   * @returns The result of the command/query execution
   * @throws Error if no handler is found
   */
  async executeJob(job: Job, entityId: string, entityType?: string): Promise<any> {
    const jobName = job.name;

    // Try command first (check scoped, then global)
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

    // Try query (check scoped, then global)
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

    // No handler found
    return undefined;
  }

  /**
   * Instantiate a command/query class from job data
   */
  private instantiateFromMetadata(
    metadata: JobCommandMetadata | JobQueryMetadata,
    entityId: string,
    jobData: Record<string, any>,
  ): any {
    const { targetClass, paramNames, entityIdParam } = metadata;

    // Build constructor arguments
    const args: any[] = [];

    for (let i = 0; i < paramNames.length; i++) {
      const paramName = paramNames[i];

      // Check if this param is the entityId
      const isEntityIdParam =
        (typeof entityIdParam === 'number' && i === entityIdParam) ||
        (typeof entityIdParam === 'string' && paramName === entityIdParam);

      if (isEntityIdParam) {
        args.push(entityId);
      } else {
        // Get from job data using param name
        args.push(jobData[paramName]);
      }
    }

    // Instantiate the class
    return new (targetClass as Type<any>)(...args);
  }

  /**
   * Get all registered job names (for debugging/documentation)
   */
  getRegisteredJobNames(): { commands: string[]; queries: string[] } {
    return {
      commands: Array.from(this.commandMap.keys()),
      queries: Array.from(this.queryMap.keys()),
    };
  }
}
