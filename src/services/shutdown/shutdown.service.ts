import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);
  private isShuttingDown = false;

  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  async onApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('Shutdown initiated');
  }
}
