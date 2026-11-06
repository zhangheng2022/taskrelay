// Deployment checks never mint devices or use device tokens for administration.
import { tsImport } from "tsx/esm/api";
const { PROTOCOL_VERSION } = await tsImport("../packages/contracts/src/index.ts", import.meta.url);
const origin =
  process.argv.find((arg) => arg.startsWith("--origin="))?.slice(9) ??
  "https://tr.zhangheng.eu.org";
if (
  !new Set(["https://tr.zhangheng.eu.org", "https://taskrelay.zhangheng.workers.dev"]).has(origin)
)
  throw new Error("DIAGNOSTIC_ORIGIN_NOT_ALLOWED");
if (process.argv.includes("--egress") || process.argv.includes("--probe-existing"))
  throw new Error("USE_AUTHENTICATED_ADMIN_MODEL_CHECK");
const checks = [
  ["/api/health", 200, ""],
  ["/api/device/status", 401, ""],
  ["/api/device/user/snapshot", 403, ""],
  ["/api/user/snapshot", 401, ""],
  ["/api/admin/operations", 401, ""],
  ["/api/user/snapshot", 403, "Bearer " + "a".repeat(64)],
  ["/api/admin/operations", 403, "Bearer " + "a".repeat(64)],
];
let gated = false;
for (const [path, expected, authorization] of checks) {
  const response = await fetch(origin + path, {
    redirect: "manual",
    headers: authorization ? { Authorization: authorization } : {},
    signal: AbortSignal.timeout(15000),
  });
  const redirect = new URL(response.headers.get("location") ?? "/", origin);
  const access =
    response.status === 302 &&
    redirect.protocol === "https:" &&
    redirect.hostname === "zhangheng.cloudflareaccess.com" &&
    !redirect.username &&
    !redirect.password;
  gated ||= access;
  if (!access && response.status !== expected)
    throw new Error(`CHECK_FAILED ${path} ${response.status}`);
  if (
    !access &&
    path === "/api/health" &&
    (await response.json()).protocolVersion !== PROTOCOL_VERSION
  )
    throw new Error("PROTOCOL_MISMATCH");
  console.log(
    JSON.stringify({ origin, path, status: response.status, accessGate: access, passed: !access }),
  );
}
console.log(
  JSON.stringify({
    origin,
    complete: !gated,
    note: gated
      ? "Access still gates user/admin checks; application authorization checks pending"
      : "Anonymous and bearer scope checks passed",
  }),
);
