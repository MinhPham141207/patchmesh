export class StorageError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
