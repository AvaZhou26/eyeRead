// Demo-only sign-in: we remember who you are with a cookie. There are no passwords,
// which is fine for testing with willing participants but NOT for a real deployment.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUser } from "./db";
import type { User } from "./types";

export const SESSION_COOKIE = "ra_uid";

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  return getUser(store.get(SESSION_COOKIE)?.value);
}

/** Use in pages: sends signed-out visitors to /login. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
