export interface Config { apiUrl: string; debug: boolean }
export function createConfig(apiUrl: string): Config { return { apiUrl, debug: false }; }
