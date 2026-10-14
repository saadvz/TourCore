import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface PinSeal {
  iv: string;
  tag: string;
  data: string;
}

export function pinKeyFor(propertyId: string): Buffer {
  return createHash("sha256").update(`cleaner-core-pin:${propertyId}`).digest();
}

export function sealPin(pin: string, key: Buffer): PinSeal {
  for (let attempt = 0; attempt < 8; attempt++) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
    const sealed = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    if (!JSON.stringify(sealed).includes(pin)) return sealed;
  }
  throw new Error("Could not seal the door code.");
}

export function openPin(sealed: PinSeal, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}
