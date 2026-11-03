function encode(a: Uint8Array) {
  let text = "";
  for (let offset = 0; offset < a.length; offset += 16_384)
    text += String.fromCharCode(...a.subarray(offset, offset + 16_384));
  return btoa(text);
}
function decode(s: string) {
  return Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
}
async function key(secret: string) {
  const raw = decode(secret);
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY_NOT_CONFIGURED");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
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
export async function unseal<T>(
  value: string,
  secret: string,
  aad: string,
): Promise<T> {
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
