import { ISerializedMessage } from '../domain';

// ═══════════════════════════════════════════════════════════════════════════
// MAIN THREAD → WORKER (Inbound to worker)
// ═══════════════════════════════════════════════════════════════════════════

export type WorkerInboundMessage =
  | WorkerExecuteMessage
  | WorkerDrainMessage
  | WorkerShutdownMessage
  | WorkerPingMessage;

export interface WorkerExecuteMessage {
  type: 'execute';
  /** Opaque ticket ID for correlating the result back */
  ticket: string;
  /** Entity key (entityType:entityId) */
  entityKey: string;
  /** The full serialized message */
  message: ISerializedMessage;
}

export interface WorkerDrainMessage {
  type: 'drain';
}

export interface WorkerShutdownMessage {
  type: 'shutdown';
  /** Hard deadline (epoch ms) — worker must exit by this time */
  deadline: number;
}

export interface WorkerPingMessage {
  type: 'ping';
  seq: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKER → MAIN THREAD (Outbound from worker)
// ═══════════════════════════════════════════════════════════════════════════

export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerDrainedMessage
  | WorkerPongMessage
  | WorkerMetricsMessage
  | WorkerFatalMessage;

export interface WorkerReadyMessage {
  type: 'ready';
  workerId: number;
}

export interface WorkerResultMessage {
  type: 'result';
  ticket: string;
  result: unknown;
}

export interface WorkerErrorMessage {
  type: 'error';
  ticket: string;
  error: string;
  stack?: string;
}

export interface WorkerDrainedMessage {
  type: 'drained';
  workerId: number;
}

export interface WorkerPongMessage {
  type: 'pong';
  seq: number;
}

export interface WorkerMetricsMessage {
  type: 'metrics';
  workerId: number;
  activeJobs: number;
  completedTotal: number;
  failedTotal: number;
  avgExecutionMs: number;
}

export interface WorkerFatalMessage {
  type: 'fatal';
  error: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED ARRAY BUFFER LAYOUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-worker layout in SharedArrayBuffer:
 *   Offset 0: Int32 — state (WorkerState enum)
 *   Offset 4: Int32 — queue depth (pending messages)
 *   Offset 8: Int32 — heartbeat low bits (ms since epoch, low 32 bits)
 *   Offset 12: Int32 — heartbeat high bits (ms since epoch, high 32 bits)
 *
 * Total per worker: 16 bytes
 */
export const WORKER_SLOT_SIZE = 16;

export const WORKER_STATE_OFFSET = 0;
export const WORKER_DEPTH_OFFSET = 1; // Int32 index (4 bytes)
export const WORKER_HEARTBEAT_LO_OFFSET = 2;
export const WORKER_HEARTBEAT_HI_OFFSET = 3;

export enum WorkerState {
  IDLE = 0,
  BUSY = 1,
  DRAINING = 2,
  DEAD = 3,
}

/**
 * Write a 64-bit timestamp to the SharedArrayBuffer using two Int32 slots.
 */
export function writeTimestamp(view: Int32Array, baseIndex: number, timestamp: number): void {
  Atomics.store(view, baseIndex + WORKER_HEARTBEAT_LO_OFFSET, timestamp & 0xffffffff);
  Atomics.store(view, baseIndex + WORKER_HEARTBEAT_HI_OFFSET, (timestamp / 0x100000000) | 0);
}

/**
 * Read a 64-bit timestamp from the SharedArrayBuffer.
 */
export function readTimestamp(view: Int32Array, baseIndex: number): number {
  const lo = Atomics.load(view, baseIndex + WORKER_HEARTBEAT_LO_OFFSET) >>> 0;
  const hi = Atomics.load(view, baseIndex + WORKER_HEARTBEAT_HI_OFFSET);
  return hi * 0x100000000 + lo;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKER BOOTSTRAP DATA (passed via workerData)
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkerBootstrapData {
  workerId: number;
  modulePath: string;
  moduleExportName: string;
  redisConfig: Record<string, unknown>;
  keyPrefix: string;
  stateBuffer: SharedArrayBuffer;
  maxWorkers: number;
}
