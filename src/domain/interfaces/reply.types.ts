/**
 * Phantom type that brands a message class with its reply type.
 * Used by generated classes so `enqueueAndWait` can infer the return type.
 *
 * @example
 * ```typescript
 * class GetStockQuery implements Reply<{ sku: string; available: number }> {
 *   declare readonly __reply: { sku: string; available: number };
 *   // ...
 * }
 *
 * // Return type inferred automatically:
 * const stock = await queueBus.enqueueAndWait(new GetStockQuery({ sku: '...' }));
 * stock.available; // typed as number
 * ```
 */

declare const __replyBrand: unique symbol;

export interface Reply<R> {
  readonly [__replyBrand]: R;
}

/**
 * Extracts the reply type from a Reply-branded message class.
 * Returns `unknown` for unbranded messages.
 */
export type InferReply<T> = T extends Reply<infer R> ? R : unknown;
