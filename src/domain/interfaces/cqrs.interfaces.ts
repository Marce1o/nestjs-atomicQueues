export interface ICommandBus {
  execute<T>(command: T): Promise<any>;
}

export interface IQueryBus {
  execute<T>(query: T): Promise<any>;
}
