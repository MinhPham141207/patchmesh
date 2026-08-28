export interface User { id: string; name: string; email: string }
export function authenticate(user: User, options?: { timeout?: number }): Promise<string> { return Promise.resolve("token"); }
