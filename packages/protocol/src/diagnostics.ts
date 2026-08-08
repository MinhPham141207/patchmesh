export interface ValidationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly value: T; readonly diagnostics: readonly [] }
  | { readonly value: null; readonly diagnostics: readonly ValidationDiagnostic[] };

export class ProtocolValidationError extends Error {
  readonly diagnostics: readonly ValidationDiagnostic[];

  constructor(diagnostics: readonly ValidationDiagnostic[]) {
    super("PatchMesh protocol validation failed");
    this.name = "ProtocolValidationError";
    this.diagnostics = diagnostics;
  }
}
