const sensitiveKey = /(?:api[_-]?key|token|password|secret|authorization|credential|private[_-]?env)/i;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return deepFreeze(value.map((item) => redactValue(item)));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [property, child] of Object.entries(value)) redacted[property] = redactValue(child, property);
    return deepFreeze(redacted);
  }
  return value;
}

export function redactEvent<T>(event: T): T {
  return redactValue(event) as T;
}
