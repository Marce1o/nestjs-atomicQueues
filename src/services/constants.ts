/**
 * Injection tokens for AtomicQueues module
 */

/** Redis client injection token */
export const ATOMIC_QUEUES_REDIS = Symbol('ATOMIC_QUEUES_REDIS');

/** Module configuration injection token */
export const ATOMIC_QUEUES_CONFIG = Symbol('ATOMIC_QUEUES_CONFIG');

/** Async module options injection token */
export const ATOMIC_QUEUES_MODULE_OPTIONS = Symbol('ATOMIC_QUEUES_MODULE_OPTIONS');
