import { authenticate, type User } from "./api.js";
export async function login(user: User): Promise<string> {
  return authenticate(user);
}
