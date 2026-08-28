import type { Result } from "./schema.js";
import { process } from "./schema.js";
export function handle(input: string): Result {
  return process(input);
}
