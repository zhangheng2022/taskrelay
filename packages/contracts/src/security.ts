import ipaddr from "ipaddr.js";

export function publicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new Error("PUBLIC_HTTPS_REQUIRED");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    (!host.includes(".") && !ipaddr.isValid(host)) ||
    /\.(local|localhost|internal|lan|home|test|invalid)$/.test(host)
  )
    throw new Error("PRIVATE_ADDRESS_BLOCKED");
  if (ipaddr.isValid(host) && !isPublicIp(host)) throw new Error("PRIVATE_ADDRESS_BLOCKED");
  return url;
}
export function isPublicIp(value: string): boolean {
  try {
    const address = ipaddr.process(value);
    return address.range() === "unicast";
  } catch {
    return false;
  }
}
export async function publicEndpoint(
  value: string,
  resolve: (host: string) => Promise<string[]>,
): Promise<URL> {
  const url = publicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some((ip) => !isPublicIp(ip)))
    throw new Error("PRIVATE_ADDRESS_BLOCKED");
  return url;
}
export function redact(value: string) {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bsk-[\w-]+/g, "[redacted]");
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function randomToken() {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(a)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
