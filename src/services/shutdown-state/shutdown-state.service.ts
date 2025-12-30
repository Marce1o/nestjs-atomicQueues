import { Injectable, OnModuleInit, Logger } from '@nestjs/common';

/**
 * ShutdownStateService
 *
 * Tracks whether the application is in the process of shutting down.
 * This is used to prevent cleanup operations (like clearing player data)
 * when sockets disconnect due to server shutdown vs intentional disconnect.
 *
 * IMPORTANT: We use direct process signal handlers (not onApplicationShutdown)
 * because onApplicationShutdown is called AFTER sockets disconnect, which is too late.
 * By registering our own handlers in onModuleInit, we catch the signal BEFORE
 * any cleanup happens.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MyService {
 *   constructor(private readonly shutdownState: ShutdownStateService) {}
 *
 *   async handleDisconnect(client: Socket) {
 *     // Skip cleanup during graceful shutdown
 *     if (this.shutdownState.isShuttingDown) {
 *       this.logger.warn('Skipping cleanup - server is shutting down');
 *       return;
 *     }
 *
 *     // Normal cleanup logic
 *     await this.cleanupUserSession(client);
 *   }
 * }
 * ```
 */
@Injectable()
export class ShutdownStateService implements OnModuleInit {
  private readonly logger = new Logger(ShutdownStateService.name);
  private shuttingDown = false;
  private shutdownSignal: NodeJS.Signals | null = null;
  private shutdownTimestamp: Date | null = null;
  private readonly shutdownCallbacks: Array<() => void | Promise<void>> = [];

  /**
   * Register signal handlers early to catch shutdown before socket disconnects.
   */
  onModuleInit(): void {
    // Register handlers for common shutdown signals
    // These run BEFORE NestJS starts its shutdown process
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

    for (const signal of signals) {
      process.on(signal, () => {
        if (!this.shuttingDown) {
          this.logger.warn(
            `Shutdown signal received: ${signal} - Setting shuttingDown flag EARLY`,
          );
          this.shuttingDown = true;
          this.shutdownSignal = signal;
          this.shutdownTimestamp = new Date();

          // Execute registered callbacks
          this.executeShutdownCallbacks();
        }
      });
    }

    this.logger.log(
      'ShutdownStateService initialized - signal handlers registered',
    );
  }

  /**
   * Check if the application is currently shutting down.
   */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Get the signal that triggered shutdown (if any).
   */
  getShutdownSignal(): NodeJS.Signals | null {
    return this.shutdownSignal;
  }

  /**
   * Get the timestamp when shutdown was initiated.
   */
  getShutdownTimestamp(): Date | null {
    return this.shutdownTimestamp;
  }

  /**
   * Register a callback to be executed when shutdown is detected.
   * These callbacks are executed synchronously in order of registration.
   */
  onShutdown(callback: () => void | Promise<void>): void {
    this.shutdownCallbacks.push(callback);
  }

  /**
   * Manually trigger shutdown state (useful for testing or programmatic shutdown).
   */
  triggerShutdown(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.shuttingDown) {
      this.logger.warn(`Manual shutdown triggered with signal: ${signal}`);
      this.shuttingDown = true;
      this.shutdownSignal = signal;
      this.shutdownTimestamp = new Date();
      this.executeShutdownCallbacks();
    }
  }

  /**
   * Execute all registered shutdown callbacks.
   */
  private async executeShutdownCallbacks(): Promise<void> {
    for (const callback of this.shutdownCallbacks) {
      try {
        await callback();
      } catch (error) {
        this.logger.error(
          `Error executing shutdown callback: ${(error as Error).message}`,
        );
      }
    }
  }
}
