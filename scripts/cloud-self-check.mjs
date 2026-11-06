// Deployment checks never mint devices or use device tokens for administration.
const origin =
  process.argv.find((arg) => arg.startsWith("--origin="))?.slice(9) ??
  "https://tr.zhangheng.eu.org";
if (!["https://tr.zhangheng.eu.org", "https://taskrelay.zhangheng.workers.dev"].includes(origin))
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
  const access =
    response.status === 302 &&
    (response.headers.get("location") ?? "").includes("zhangheng.cloudflareaccess.com");
  gated ||= access;
  if (!access && response.status !== expected)
    throw new Error(`CHECK_FAILED ${path} ${response.status}`);
  if (path === "/api/health" && (await response.json()).protocolVersion !== 16)
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
