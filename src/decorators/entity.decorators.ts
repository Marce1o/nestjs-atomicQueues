import { ENTITY_TYPE_METADATA, ENTITY_ID_METADATA } from './constants';
import { queueEntityIdRegistry } from './registry';
import { getConstructorParamName } from './utils';

/**
 * @EntityType decorator
 *
 * Marks a command/query class with its entity type for automatic routing.
 * When present, queueBus.enqueue(cmd) can auto-route without forEntity().
 *
 * @example
 * ```typescript
 * @EntityType('account')
 * export class WithdrawCommand {
 *   @QueueEntityId()
 *   public readonly accountId: string;
 *   public readonly amount: number;
 * }
 *
 * // Can now use direct enqueue:
 * await queueBus.enqueue(new WithdrawCommand(accountId, amount));
 * ```
 */
export function EntityType(entityType: string): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(ENTITY_TYPE_METADATA, entityType, target);
  };
}

/**
 * @QueueEntityId decorator
 *
 * Marks a property OR constructor parameter as the entity ID for queue routing.
 * Only ONE @QueueEntityId() allowed per class (enforced at decoration time).
 * Overrides module-level defaultEntityId configuration.
 *
 * @example Property decorator:
 * ```typescript
 * export class TransferCommand {
 *   @QueueEntityId()
 *   public readonly sourceAccountId: string;
 *   public readonly amount: number;
 * }
 * ```
 *
 * @example Parameter decorator (recommended):
 * ```typescript
 * @QueueEntity('account')
 * export class TransferCommand {
 *   constructor(
 *     @QueueEntityId() public readonly sourceAccountId: string,
 *     public readonly amount: number,
 *   ) {}
 * }
 * ```
 */
export function QueueEntityId(): PropertyDecorator & ParameterDecorator {
  return (target: object, propertyKey: string | symbol | undefined, parameterIndex?: number) => {
    // Parameter decorator case (on constructor param)
    if (typeof parameterIndex === 'number') {
      const constructor = target as Function;
      const className = constructor.name;

      // Extract parameter name from constructor
      const paramName = getConstructorParamName(constructor, parameterIndex);
      if (!paramName) {
        throw new Error(
          `Cannot determine parameter name at index ${parameterIndex} in ${className}. ` +
            `Ensure you're using 'public readonly paramName' syntax.`,
        );
      }

      // Check for duplicate
      const existing = queueEntityIdRegistry.get(constructor);
      if (existing) {
        throw new Error(
          `Multiple @QueueEntityId() decorators on ${className}. ` +
            `Found on '${existing}' and '${paramName}'. ` +
            `Only one parameter/property can be the entity ID.`,
        );
      }

      queueEntityIdRegistry.set(constructor, paramName);
      Reflect.defineMetadata(ENTITY_ID_METADATA, paramName, constructor);
      return;
    }

    // Property decorator case (on class property)
    const constructor = target.constructor;
    const className = constructor.name;
    const propName = String(propertyKey);

    // Check for duplicate @QueueEntityId on same class
    const existing = queueEntityIdRegistry.get(constructor);
    if (existing) {
      throw new Error(
        `Multiple @QueueEntityId() decorators on ${className}. ` +
          `Found on '${existing}' and '${propName}'. ` +
          `Only one property can be the entity ID.`,
      );
    }

    queueEntityIdRegistry.set(constructor, propName);
    Reflect.defineMetadata(ENTITY_ID_METADATA, propName, constructor);
  };
}

/**
 * @deprecated Use @QueueEntityId() instead. This alias is provided for backwards compatibility.
 */
export const EntityId = QueueEntityId;

// =============================================================================
// NEW COMBINED DECORATOR - Less Invasive
// =============================================================================

/**
 * @QueueEntity decorator
 *
 * Single decorator that combines @EntityType and @QueueEntityId into one.
 * This is the recommended way to mark commands/queries for queue routing.
 *
 * @param entityType - The entity type for routing (e.g., 'table', 'account')
 * @param entityIdProperty - Optional property name containing the entity ID.
 *                           If omitted, uses module-level defaultEntityId from entities config.
 *
 * @example
 * // With explicit property name:
 * @QueueEntity('table', 'tableId')
 * export class MakeBetCommand {
 *   constructor(
 *     public readonly tableId: string,  // <- unchanged!
 *     public readonly amount: number,
 *   ) {}
 * }
 *
 * @example
 * // Using module default (entities config has defaultEntityId: 'tableId'):
 * @QueueEntity('table')
 * export class DealCommand {
 *   constructor(
 *     public readonly tableId: string,
 *     public readonly card: string,
 *   ) {}
 * }
 *
 * @example
 * // Then just enqueue directly:
 * await queueBus.enqueue(new MakeBetCommand(tableId, 100));
 */
export function QueueEntity(entityType: string, entityIdProperty?: string): ClassDecorator {
  return (target: Function) => {
    // Always set entity type
    Reflect.defineMetadata(ENTITY_TYPE_METADATA, entityType, target);

    // Set entity ID property if provided (otherwise falls back to module config)
    if (entityIdProperty) {
      Reflect.defineMetadata(ENTITY_ID_METADATA, entityIdProperty, target);
    }
  };
}
