import crypto from "node:crypto";

/**
 * Encrypts provider credentials before they are stored (AES-256-GCM). The key comes from TELEPHONY_SECRET_KEY
 * (at least 32 characters, never committed). Without it nothing can be stored: there is no built-in default key.
 */
const key = () => {
  const raw = process.env.TELEPHONY_SECRET_KEY;
  if (!raw || raw.length < 32) throw new Error("TELEPHONY_SECRET_KEY must be set (at least 32 characters) before provider credentials can be stored.");
  return crypto.createHash("sha256").update(raw).digest();
};

export const secretsConfigured = () => !!process.env.TELEPHONY_SECRET_KEY && process.env.TELEPHONY_SECRET_KEY.length >= 32;

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, enc] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("Unrecognised secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

/** "••••1234": enough to recognise a stored secret, never enough to use it. */
export const maskSecret = (plain: string) => (plain.length <= 4 ? "••••" : `••••${plain.slice(-4)}`);
