const MAX_DIAGNOSTIC_LENGTH = 512;
const SECRET_NAME = "(?:api[_-]?key|access[_-]?token|auth(?:orization)?|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|credential|private[_-]?key)";

export function sanitizeDiagnostic(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(/(\bBearer\s+)[^\s]+/giu, "$1<redacted>");
  sanitized = sanitized.replace(
    new RegExp(`(${SECRET_NAME}\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`, "giu"),
    "$1<redacted>",
  );
  sanitized = sanitized.replace(
    new RegExp(`([?&])(${SECRET_NAME}=)[^&\\s]+`, "giu"),
    "$1$2<redacted>",
  );
  return sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH);
}
