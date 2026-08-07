export const EXIT_OK = 0;
export const EXIT_CONTRACT_INVALID = 1;
export const EXIT_TOOL_FAILURE = 2;

export function diagnostic(code, path, pointer, message) {
  return Object.freeze({ code, path, pointer, message });
}

export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((a, b) => a.path.localeCompare(b.path)
    || a.pointer.localeCompare(b.pointer) || a.code.localeCompare(b.code)
    || a.message.localeCompare(b.message));
}

export function formatDiagnostics(diagnostics) {
  return sortDiagnostics(diagnostics).map(({ code, path, pointer, message }) =>
    `${code} ${path}${pointer}: ${message}`).join('\n');
}
