import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync } from "node:fs";
import * as argon from "argon2";
import * as OTPAuth from "otpauth";
import { HttpException } from "@nestjs/common";
import type { ErrorCode } from "@palimora/contracts";
export function fail(code: ErrorCode, status = 400): never {
  throw new HttpException({ code }, status);
}
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const random = () => randomBytes(32).toString("base64url");
export const hashPassword = (password: string) =>
  argon.hash(password, {
    type: argon.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export const verifyPassword = async (hash: string, password: string) =>
  argon.verify(hash, password).catch(() => false);
export function config() {
  const origin = new URL(process.env.APP_ORIGIN ?? "http://localhost:5173");
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    !["https:", "http:"].includes(origin.protocol)
  )
    throw Error("Invalid APP_ORIGIN");
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:")
    throw Error("Production requires HTTPS APP_ORIGIN");
  return {
    origin: origin.origin,
    rpID: origin.hostname,
    secure: origin.protocol === "https:",
  };
}
function key() {
  const raw = process.env.AUTH_KEY_FILE
    ? readFileSync(process.env.AUTH_KEY_FILE, "utf8").trim()
    : process.env.AUTH_KEY;
  if (!raw || !/^[a-f0-9]{64}$/i.test(raw))
    throw Error("AUTH_KEY_FILE must contain a 32-byte hex key");
  return Buffer.from(raw, "hex");
}
export function seal(text: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  return Buffer.concat([
    iv,
    cipher.update(text, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function unseal(text: string, encryptionKey: Buffer = key()) {
  const b = Buffer.from(text, "base64"),
    cipher = createDecipheriv("aes-256-gcm", encryptionKey, b.subarray(0, 12));
  cipher.setAuthTag(b.subarray(-16));
  return Buffer.concat([
    cipher.update(b.subarray(12, -16)),
    cipher.final(),
  ]).toString("utf8");
}
export function totp(secret: string, label = "Palimora") {
  return new OTPAuth.TOTP({
    issuer: "Palimora",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
export function validateConfig() {
  config();
  key();
  if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD_FILE)
    throw Error("DATABASE_URL required");
}
