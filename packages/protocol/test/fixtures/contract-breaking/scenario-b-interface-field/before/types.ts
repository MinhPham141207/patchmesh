export interface Config { apiUrl: string; apiKey: string; debug: boolean }
export function createConfig(apiUrl: string, apiKey: string): Config { return { apiUrl, apiKey, debug: false }; }
