import { createConfig, type Config } from "./types.js";
export function useConfig(): Config {
  return createConfig("https://api.example.com", "secret-key");
}
