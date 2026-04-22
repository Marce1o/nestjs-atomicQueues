export const DEFAULT_KEY_PREFIX = 'aq';

export function resolveKeyPrefix(config: { keyPrefix?: string }): string {
  return config.keyPrefix || DEFAULT_KEY_PREFIX;
}
