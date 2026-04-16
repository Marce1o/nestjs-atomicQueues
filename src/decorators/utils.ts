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
 * Helper to extract constructor parameter names using reflection
 */
export function getConstructorParamNames(target: Function): string[] {
  const paramTypes = Reflect.getMetadata('design:paramtypes', target) || [];

  // Try to extract parameter names from the constructor string
  const constructorStr = target.toString();
  const match = constructorStr.match(/constructor\s*\(([^)]*)\)/);

  if (match && match[1]) {
    return match[1]
      .split(',')
      .map((param) => {
        // Handle various patterns:
        // "public readonly tableId: string" -> "tableId"
        // "tableId" -> "tableId"
        // "private tableId: string" -> "tableId"
        const cleaned = param.trim();
        const nameMatch = cleaned.match(/(?:public\s+)?(?:private\s+)?(?:protected\s+)?(?:readonly\s+)?(\w+)/);
        return nameMatch ? nameMatch[1] : cleaned;
      })
      .filter((name) => name.length > 0);
  }

  // Fallback: generate param0, param1, etc.
  return paramTypes.map((_: any, i: number) => `param${i}`);
}
