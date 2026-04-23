/**
 * Extract parameter name from constructor function by parsing its string representation.
 * Works with TypeScript's 'public readonly paramName' shorthand.
 */
export function getConstructorParamName(constructor: Function, index: number): string | undefined {
  const fnStr = constructor.toString();

  // Match constructor parameters - handles various formats
  const constructorMatch = fnStr.match(/constructor\s*\(([^)]*)\)/);
  if (!constructorMatch) return undefined;

  const paramsStr = constructorMatch[1];
  if (!paramsStr.trim()) return undefined;

  // Split by comma, but be careful with nested generics/objects
  const params = splitParams(paramsStr);
  if (index >= params.length) return undefined;

  const param = params[index].trim();

  // Extract the actual parameter name, handling:
  // - @Decorator() public readonly paramName: Type
  // - public readonly paramName: Type
  // - paramName: Type
  // - paramName
  const nameMatch = param.match(/(?:@\w+\([^)]*\)\s*)*(?:public\s+)?(?:readonly\s+)?(\w+)/);
  return nameMatch ? nameMatch[1] : undefined;
}

/**
 * Split parameter string by commas, respecting nested structures
 */
export function splitParams(paramsStr: string): string[] {
  const params: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of paramsStr) {
    if (char === '(' || char === '<' || char === '{' || char === '[') {
      depth++;
      current += char;
    } else if (char === ')' || char === '>' || char === '}' || char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      params.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    params.push(current);
  }

  return params;
}

/**
 * Helper to convert class name to kebab-case job name
 * MakeBetCommand -> make-bet
 * ProcessPaymentCommand -> process-payment
 */
export function deriveJobName(className: string, suffix: string): string {
  return className
    .replace(new RegExp(`${suffix}$`), '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Extract all constructor parameter names, delegating to getConstructorParamName
 * which correctly handles decorators via splitParams.
 */
export function getConstructorParamNames(target: Function): string[] {
  const fnStr = target.toString();
  const constructorMatch = fnStr.match(/constructor\s*\(([^)]*)\)/);
  if (!constructorMatch || !constructorMatch[1].trim()) {
    const paramTypes = Reflect.getMetadata('design:paramtypes', target) || [];
    return paramTypes.map((_: unknown, i: number) => `param${i}`);
  }

  const params = splitParams(constructorMatch[1]);
  const names: string[] = [];
  for (let i = 0; i < params.length; i++) {
    const name = getConstructorParamName(target, i);
    if (name) names.push(name);
  }
  return names;
}
