export interface MessageSpec {
  kind: 'command' | 'query';
  schema?: Record<string, any>;
  replySchema?: Record<string, any>;
}

export interface EntityContract {
  entityType: string;
  serviceName: string;
  version: string;
  messages: Record<string, MessageSpec>;
  registeredAt: number;
  lastHeartbeat: number;
}

export interface RegistryChange {
  entityType: string;
  action: 'registered' | 'updated' | 'removed';
  serviceName: string;
}

export interface RegistrySnapshot {
  generatedAt: number;
  keyPrefix: string;
  entities: EntityContract[];
}
