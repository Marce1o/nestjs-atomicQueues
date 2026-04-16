import { Injectable, Logger } from '@nestjs/common';
import { WorkerProcessorOptions, EntityScalerOptions } from '../../decorators';

/**
 * Registered processor info
 */
export interface RegisteredProcessor {
  entityType: string;
  processorInstance: any;
  options: WorkerProcessorOptions;
  jobHandlers: Map<string, { method: string; isWildcard: boolean }>;
  wildcardHandler?: { method: string };
  queueNameFn: (entityId: string) => string;
  workerNameFn: (entityId: string) => string;
}

/**
 * Registered scaler info
 */
export interface RegisteredScaler {
  entityType: string;
  scalerInstance: any;
  options: EntityScalerOptions;
  methods: {
    getActiveEntities?: string;
    getDesiredWorkerCount?: string;
    onSpawnWorker?: string;
    onTerminateWorker?: string;
  };
}

/**
 * ProcessorRegistry
 *
 * Holds the state (Maps) for processors, scalers, and active workers.
 * Provides CRUD operations for these registrations.
 */
@Injectable()
export class ProcessorRegistry {
  private readonly logger = new Logger(ProcessorRegistry.name);
  private readonly processors: Map<string, RegisteredProcessor> = new Map();
  private readonly scalers: Map<string, RegisteredScaler> = new Map();
  private readonly activeWorkers: Map<string, Set<string>> = new Map();

  // ---- Processors ----

  addProcessor(entityType: string, processor: RegisteredProcessor): void {
    this.processors.set(entityType, processor);
    this.activeWorkers.set(entityType, new Set());
  }

  getProcessor(entityType: string): RegisteredProcessor | undefined {
    return this.processors.get(entityType);
  }

  hasProcessor(entityType: string): boolean {
    return this.processors.has(entityType);
  }

  getAllProcessors(): Map<string, RegisteredProcessor> {
    return this.processors;
  }

  // ---- Scalers ----

  addScaler(entityType: string, scaler: RegisteredScaler): void {
    this.scalers.set(entityType, scaler);
  }

  getScaler(entityType: string): RegisteredScaler | undefined {
    return this.scalers.get(entityType);
  }

  hasScaler(entityType: string): boolean {
    return this.scalers.has(entityType);
  }

  getAllScalers(): Map<string, RegisteredScaler> {
    return this.scalers;
  }

  // ---- Active Workers ----

  addActiveWorker(entityType: string, entityId: string): void {
    this.activeWorkers.get(entityType)?.add(entityId);
  }

  removeActiveWorker(entityType: string, entityId: string): void {
    this.activeWorkers.get(entityType)?.delete(entityId);
  }

  hasActiveWorker(entityType: string, entityId: string): boolean {
    return this.activeWorkers.get(entityType)?.has(entityId) ?? false;
  }

  getActiveWorkers(entityType: string): string[] {
    return Array.from(this.activeWorkers.get(entityType) || []);
  }

  // ---- Aggregate ----

  getRegisteredEntityTypes(): string[] {
    return Array.from(
      new Set([...this.processors.keys(), ...this.scalers.keys()]),
    );
  }
}
