// Sign-in. Real accounts use an email + password (hashed with scrypt, never stored as-is).
// Demo accounts (the seeded professor/student and anyone from the old demo) sign in with one click.
// We remember who you are with a signed cookie: "<userId>.<signature>", so it can't be forged.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOrCreateSecret, getUser } from "./db";
import type { User } from "./types";

export const SESSION_COOKIE = "ra_session";
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

async function secret(): Promise<string> {
  return process.env.AUTH_SECRET || (await getOrCreateSecret());
}

async function sign(userId: string): Promise<string> {
  const mac = createHmac("sha256", await secret()).update(userId).digest("base64url");
  return `${userId}.${mac}`;
}

async function verify(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const expected = Buffer.from(await sign(userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, saltB64, hashB64] = stored.split(":");
  if (kind !== "scrypt" || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, "base64url");
  const got = await scrypt(pw, Buffer.from(saltB64, "base64url"), want.length);
  return timingSafeEqual(want, got);
}

/** Call from a route handler after a successful sign-in / sign-up. */
export async function startSession(userId: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, await sign(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const id = await verify(store.get(SESSION_COOKIE)?.value);
  return id ? getUser(id) : null;
}

/** Use in pages: sends signed-out visitors to /login. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
