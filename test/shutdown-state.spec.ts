import 'reflect-metadata';
import { ShutdownStateService } from '../src/services/shutdown-state/shutdown-state.service';

describe('ShutdownStateService', () => {
  let service: ShutdownStateService;
  const originalListeners = new Map<string, Function[]>();

  beforeEach(() => {
    // Snapshot existing listeners so we can clean up after
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
      originalListeners.set(sig, process.listeners(sig as any) as Function[]);
    }
    service = new ShutdownStateService();
  });

  afterEach(() => {
    // Remove any listeners the service added
    for (const [sig, orig] of originalListeners) {
      const current = process.listeners(sig as any) as Function[];
      for (const listener of current) {
        if (!orig.includes(listener)) {
          process.removeListener(sig as any, listener as any);
        }
      }
    }
  });

  it('should not be shutting down initially', () => {
    expect(service.isShuttingDown).toBe(false);
    expect(service.getShutdownSignal()).toBeNull();
    expect(service.getShutdownTimestamp()).toBeNull();
  });

  it('triggerShutdown should set shutdown state', () => {
    service.triggerShutdown('SIGTERM');

    expect(service.isShuttingDown).toBe(true);
    expect(service.getShutdownSignal()).toBe('SIGTERM');
    expect(service.getShutdownTimestamp()).toBeInstanceOf(Date);
  });

  it('triggerShutdown should default to SIGTERM', () => {
    service.triggerShutdown();
    expect(service.getShutdownSignal()).toBe('SIGTERM');
  });

  it('triggerShutdown should be idempotent', () => {
    service.triggerShutdown('SIGINT');
    const firstTimestamp = service.getShutdownTimestamp();

    // Second trigger should be ignored
    service.triggerShutdown('SIGTERM');
    expect(service.getShutdownSignal()).toBe('SIGINT'); // still first signal
    expect(service.getShutdownTimestamp()).toBe(firstTimestamp);
  });

  it('should execute registered callbacks on shutdown', async () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();

    service.onShutdown(cb1);
    service.onShutdown(cb2);

    service.triggerShutdown();

    // Callbacks are executed asynchronously, give a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('should not re-execute callbacks on duplicate trigger', async () => {
    const cb = jest.fn();
    service.onShutdown(cb);

    service.triggerShutdown();
    service.triggerShutdown(); // should be ignored

    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('should handle callback errors gracefully', async () => {
    const errorCb = jest.fn().mockRejectedValue(new Error('cb failed'));
    const successCb = jest.fn();

    service.onShutdown(errorCb);
    service.onShutdown(successCb);

    service.triggerShutdown();

    await new Promise((r) => setTimeout(r, 10));

    expect(errorCb).toHaveBeenCalled();
    expect(successCb).toHaveBeenCalled(); // should still execute
  });
});
