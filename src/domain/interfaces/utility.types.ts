/**
 * Deep partial type utility
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Constructor type
 */
export type Constructor<T = unknown> = new (...args: unknown[]) => T;

/**
 * Async factory function type
 */
export type AsyncFactory<T> = () => Promise<T> | T;
