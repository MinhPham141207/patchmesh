const MAX_DIAGNOSTIC_LENGTH = 512;

export function sanitizeDiagnostic(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(/(\bBearer\s+)[^\s]+/giu, "$1<redacted>");
  sanitized = sanitized.replace(
    /((?:api[_-]?key|access[_-]?token|password|passwd|secret|credential|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1<redacted>",
  );
  sanitized = sanitized.replace(
    /([?&](?:api[_-]?key|access[_-]?token|password|passwd|secret|credential)=[^&\s]+)/giu,
    "$1<redacted>",
  );
  return sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH);
}
