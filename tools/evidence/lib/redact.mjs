import { sha256 } from "./canonical.mjs";

const SECRET_KEY = /(token|password|secret|authorization|cookie|api[_-]?key|private[_-]?key)/i;

function isSecretKey(key) {
  return SECRET_KEY.test(key);
}

function redactNested(value, placeholder) {
  if (Array.isArray(value)) return value.map((item) => redactNested(item, placeholder));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSecretKey(key) ? placeholder : redactNested(child, placeholder),
    ]));
  }
  return value;
}

export function redactValue(value, { maxTextBytes = 4096, placeholder = "[REDACTED]" } = {}) {
  if (typeof value !== "string") {
    const redactedValue = redactNested(value, placeholder);
    return { value: redactedValue, redacted: redactedValue !== value, digest: sha256(value), redactionCount: 0 };
  }
  const redactedValue = value.length > maxTextBytes ? `${value.slice(0, maxTextBytes)}${placeholder}` : value;
  return {
    value: redactedValue,
    redacted: redactedValue !== value,
    digest: sha256(value),
    redactionCount: redactedValue === value ? 0 : 1,
  };
}

export function redactObject(value, options = {}) {
  const placeholder = options.placeholder ?? "[REDACTED]";
  let redactionCount = 0;
  function visit(input) {
    if (Array.isArray(input)) return input.map(visit);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, child]) => {
        if (isSecretKey(key)) {
          redactionCount += 1;
          return [key, placeholder];
        }
        return [key, visit(child)];
      }));
    }
    return input;
  }
  return { value: visit(value), redactionCount };
}
