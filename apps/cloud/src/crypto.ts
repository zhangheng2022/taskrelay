import { Buffer } from "node:buffer";

function encode(a: Uint8Array) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
}
function decode(s: string) {
  // Buffer's native codec avoids a JavaScript callback for every decoded byte.
  // Keep the previous decoder's rejection of malformed/non-base64 input.
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1)
    throw new Error("INVALID_ENCRYPTED_DATA");
  return new Uint8Array(Buffer.from(s, "base64"));
}
async function key(secret: string) {
  const raw = decode(secret);
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY_NOT_CONFIGURED");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(value: unknown, secret: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    v: 1,
    iv: encode(iv),
    data: encode(new Uint8Array(data)),
  });
}
export async function unseal<T>(value: string, secret: string, aad: string): Promise<T> {
  const packet = JSON.parse(value);
  if (packet.v !== 1) throw new Error("UNKNOWN_ENCRYPTION_VERSION");
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(packet.iv),
      additionalData: new TextEncoder().encode(aad),
    },
    await key(secret),
    decode(packet.data),
  );
  return JSON.parse(new TextDecoder().decode(data));
}
