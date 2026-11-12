/** 连接由管理端登记；不可变的上游与密钥别名决定网关路由。运行令牌只发送到两个固定的 Cloudflare 端点。 */
import {
  connectionInputSchema,
  type ModelConnection,
  type EgressRegion,
} from "../../../packages/contracts/src/index";
import { publicEndpoint } from "../../../packages/contracts/src/security";
import type { AppEnv } from "./env";
import type { Row } from "./store";

export async function validateEndpoint(baseUrl: string) {
  return publicEndpoint(baseUrl, async (host) => {
    const results = await Promise.all(
      ["A", "AAAA"].map(async (type) => {
        const response = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
          {
            headers: { accept: "application/dns-json" },
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok) throw new Error("DNS_LOOKUP_FAILED");
        const data = (await response.json()) as {
          Status: number;
          Answer?: { type: number; data: string }[];
        };
        if (data.Status !== 0) throw new Error("DNS_LOOKUP_FAILED");
        return (data.Answer ?? []).filter((x) => x.type === 1 || x.type === 28).map((x) => x.data);
      }),
    );
    return results.flat();
  });
}
export function connectionFrom(row: Row): ModelConnection {
  const shared = {
    id: row.id,
    name: row.name,
    defaultRegion: row.default_region as EgressRegion,
    bindingVerified: Boolean(row.binding_verified),
    gatewayProvider: row.provider,
    keyAlias: row.key_alias,
  };
  if (row.kind === "workers-ai") return { ...shared, kind: "workers-ai" };
  if (row.kind === "custom") return { ...shared, kind: "custom", upstream: row.upstream };
  return { ...shared, kind: "provider", provider: row.provider };
}

/** 删除预览只返回平台连接及其模型版本引用；密钥和上游配置不进入确认数据。 */
export async function connectionDeletionPreview(env: AppEnv, id: string) {
  const connection = await env.DB.prepare(
    "SELECT name FROM model_connections WHERE id=? AND owner_user_id IS NULL",
  )
    .bind(id)
    .first<{ name: string }>();
  if (!connection) throw Error("MODEL_CONNECTION_NOT_FOUND");
  const { results } = await env.DB.prepare(
    `SELECT id AS modelId,version,COALESCE(json_extract(config,'$.name'),id) AS name,
      COUNT(*) OVER() AS total FROM model_profile_versions WHERE connection_id=?
      ORDER BY id,version LIMIT 20`,
  )
    .bind(id)
    .all<{ modelId: string; version: number; name: string; total: number }>();
  return {
    name: connection.name,
    referenceCount: results[0]?.total ?? 0,
    references: results.map(({ modelId, version, name }) => ({ modelId, version, name })),
  };
}

export async function createConnection(env: AppEnv, input: unknown) {
  const config = connectionInputSchema.parse(input);
  const id = crypto.randomUUID();
  let upstream: string | null = null;
  if (config.kind === "custom") {
    const url = new URL(config.upstream);
    if (
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.protocol !== "https:" ||
      !/^[A-Za-z0-9_./~-]+$/.test(url.pathname) ||
      url.pathname.includes("//")
    )
      throw Error("MODEL_BASE_URL_INVALID");
    await validateEndpoint(url.href);
    upstream = url.href.replace(/\/$/, "");
  }
  // 使用短 UUID 字符串生成两类账号级标识，避免展示名碰撞或用户指定其他租户的别名。
  const slug = id.replaceAll("-", "");
  const provider =
    config.kind === "custom"
      ? "custom-" + slug
      : config.kind === "provider"
        ? config.provider
        : "workers-ai";
  const alias = config.kind === "workers-ai" ? null : slug;
  await env.DB.prepare(
    "INSERT INTO model_connections(id,name,kind,provider,upstream,key_alias,default_region,binding_verified) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      config.name,
      config.kind,
      provider,
      upstream,
      alias,
      config.defaultRegion,
      Number(config.kind === "workers-ai"),
    )
    .run();
  return {
    ...config,
    id,
    bindingVerified: config.kind === "workers-ai",
    gatewayProvider: provider,
    keyAlias: alias,
  };
}

export function gatewayTransport(env: AppEnv, connection: ModelConnection, model: string) {
  const account = env.AI_GATEWAY_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_ID;
  if (!connection.bindingVerified) throw Error("MODEL_GATEWAY_BINDING_REQUIRED");
  const workers = connection.kind === "workers-ai";
  const token = workers ? env.WORKERS_AI_TOKEN : env.AI_GATEWAY_TOKEN;
  if (
    !account ||
    !/^[a-f0-9]{32}$/.test(account) ||
    !gateway ||
    !/^[a-z0-9-]{1,64}$/.test(gateway) ||
    !token
  )
    throw Error("MODEL_GATEWAY_NOT_CONFIGURED");
  if (workers && !/^@cf\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(model))
    throw Error("WORKERS_AI_MODEL_INVALID");
  const prefix =
    connection.kind === "custom" ? new URL(connection.upstream).pathname.replace(/\/$/, "") : "";
  const baseUrl = workers
    ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`
    : `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/${connection.gatewayProvider}${prefix}`;
  return {
    baseUrl,
    fetch: (input: string | URL, init?: RequestInit) => {
      if (String(input) !== baseUrl + "/responses") throw Error("MODEL_GATEWAY_ROUTE_INVALID");
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.set("cf-aig-collect-log-payload", "false");
      headers.set("cf-aig-skip-cache", "true");
      headers.set("cf-aig-max-attempts", "1");
      if (workers) {
        headers.set("authorization", "Bearer " + token);
        headers.set("cf-aig-gateway-id", gateway);
      } else {
        if (!connection.keyAlias) throw Error("MODEL_GATEWAY_ALIAS_REQUIRED");
        headers.set("cf-aig-authorization", "Bearer " + token);
        headers.set("cf-aig-byok-alias", connection.keyAlias);
      }
      return fetch(input, { ...init, headers, redirect: "manual" });
    },
  };
}
