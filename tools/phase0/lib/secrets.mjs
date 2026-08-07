import { diagnostic, sortDiagnostics } from './diagnostics.mjs';

const SECRET_KEYS = new Set(['apikey', 'authorization', 'credential', 'credentials', 'password', 'passwd', 'privatekey', 'secret', 'token']);
const SECRET_VALUES = [/\bBearer\s+\S+/iu, /\bsk-[A-Za-z0-9_-]{16,}\b/u, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u, /\bAKIA[0-9A-Z]{16}\b/u, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u];
const escape = (value) => value.replaceAll('~', '~0').replaceAll('/', '~1');

export function findSecretDiagnostics(value, path) {
  const diagnostics = [];
  function visit(current, at) {
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, `${at}/${index}`));
    if (current && typeof current === 'object') {
      for (const key of Object.keys(current).sort()) {
        const child = `${at}/${escape(key)}`;
        if (SECRET_KEYS.has(key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')) && current[key] !== '<redacted>') diagnostics.push(diagnostic('PHASE0_SECRET_PATTERN', path, child, 'prohibited secret-bearing key must contain <redacted>'));
        else visit(current[key], child);
      }
    } else if (typeof current === 'string' && SECRET_VALUES.some((pattern) => pattern.test(current))) diagnostics.push(diagnostic('PHASE0_SECRET_PATTERN', path, at, 'prohibited secret-shaped value'));
  }
  visit(value, '');
  return sortDiagnostics(diagnostics);
}
