let counter = 0;
let prefix = '';

export function initFastId(serverId: string): void {
  prefix = serverId;
  counter = 0;
}

export function fastId(): string {
  return `${prefix}-${++counter}-${Date.now().toString(36)}`;
}
