import { createHash } from 'node:crypto';

function encode(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires a finite JSON number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalize(value) { return encode(value); }
export function canonicalDigest(value) { return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex'); }
