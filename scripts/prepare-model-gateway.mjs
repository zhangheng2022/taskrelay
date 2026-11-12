/** 部署准备：仅在专用网关缺失时创建。已有配置不符时报告，运行服务不持有管理凭据。 */
import { account, cloudflare, query } from "./release-api.mjs";
import { pathToFileURL } from "node:url";
const path = `/accounts/${account}/ai-gateway/gateways`;
export async function checkGateway(create = false, api = cloudflare) {
  let gateway;
  try {
    gateway = await api(path + "/taskrelay");
  } catch (error) {
    if (!create || error.message !== "CLOUDFLARE_API_FAILED:404") throw error;
    await api(path, "POST", {
      id: "taskrelay",
      authentication: true,
      byok_only: true,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      retry_max_attempts: 1,
      workers_ai_billing_mode: "postpaid",
    });
    gateway = await api(path + "/taskrelay");
  }
  if (
    gateway.id !== "taskrelay" ||
    !gateway.authentication ||
    !gateway.byok_only ||
    gateway.cache_ttl !== 0 ||
    (gateway.retry_max_attempts ?? 1) > 1 ||
    gateway.workers_ai_billing_mode !== "postpaid" ||
    !gateway.collect_logs
  )
    throw Error("MODEL_GATEWAY_SETTINGS_REQUIRED");
}
// 验证仅在配置服务执行。列表响应可能含密钥预览，既不打印也不持久化。
export async function verifyConnectionBinding(row, api = cloudflare) {
  if (row.kind === "workers-ai") return;
  const expectedProviders = new Set([row.provider]);
  if (row.kind === "custom") {
    const slug = row.provider.slice("custom-".length);
    expectedProviders.add(slug);
    const providers = await api(
      `/accounts/${account}/ai-gateway/custom-providers?enable=true&search=${encodeURIComponent(slug)}&per_page=100`,
    );
    const provider = providers.find((entry) => entry.slug === slug && entry.enable === true);
    if (!provider || provider.base_url.replace(/\/$/, "") !== new URL(row.upstream).origin)
      throw Error("MODEL_GATEWAY_UPSTREAM_MISMATCH");
  }
  for (let page = 1; ; page++) {
    const entries = await api(`${path}/taskrelay/provider_configs?per_page=100&page=${page}`);
    if (
      entries.some(
        (entry) =>
          entry.gateway_id === "taskrelay" &&
          expectedProviders.has(entry.provider_slug) &&
          entry.alias === row.key_alias &&
          entry.secret_id,
      )
    )
      return;
    if (entries.length < 100) throw Error("MODEL_GATEWAY_KEY_BINDING_MISSING");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkGateway(process.argv.includes("--create"));
  if (process.argv.includes("--verify-connection")) {
    const id = process.argv[process.argv.indexOf("--verify-connection") + 1];
    if (!id) throw Error("MODEL_CONNECTION_ID_REQUIRED");
    const row = (await query("SELECT * FROM model_connections WHERE id=?", [id]))[0].results[0];
    if (!row) throw Error("MODEL_CONNECTION_NOT_FOUND");
    await query("UPDATE model_connections SET binding_verified=0 WHERE id=?", [id]);
    await verifyConnectionBinding(row);
    await query("UPDATE model_connections SET binding_verified=1 WHERE id=?", [id]);
    console.log("供应商连接的上游和凭据绑定已核验。");
  } else console.log("taskrelay 网关配置已核验。");
}
