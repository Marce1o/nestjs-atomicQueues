export interface ICommandBus {
  execute<T>(command: T): Promise<unknown>;
}

export interface IQueryBus {
  execute<T>(query: T): Promise<unknown>;
}
