import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SignJWT, jwtVerify } from "jose";

const COOKIE = "navs_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 днів

// ---------------------------------------------------------------------------
// Сесія (JWT у httpOnly cookie)
// ---------------------------------------------------------------------------
export type Session = { login: string; name: string; role: string; group?: string };

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export function cookie(value: string, maxAge: number) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function readSession(req: VercelRequest): Promise<Session | null> {
  const raw = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret());
    return {
      login: String(payload.sub),
      name: String(payload.name ?? ""),
      role: typeof payload.role === "string" ? payload.role : "student",
      group: typeof payload.group === "string" ? payload.group : undefined,
    };
  } catch {
    return null;
  }
}

export async function startSession(res: VercelResponse, s: Session) {
  const token = await new SignJWT({ name: s.name, role: s.role, group: s.group })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.login)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  res.setHeader("Set-Cookie", cookie(token, MAX_AGE));
  return res.status(200).json({ user: s });
}
