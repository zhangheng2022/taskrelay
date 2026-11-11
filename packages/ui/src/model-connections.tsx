/** 管理员只登记不可变的供应商路由。显示服务端分配的标识，供管理员在 Cloudflare 绑定凭据。 */
import { useRef, useState } from "react";
import {
  connectionInputSchema,
  type ModelConnection,
  type EgressRegion,
  type Transport,
} from "../../contracts/src/index";
import { createApi, rpcData } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Field } from "./form-field";
import { ErrorText } from "./feedback";

const regions = (
  <>
    <option value="auto">自动</option>
    <option value="us">美国</option>
    <option value="eu">欧盟</option>
  </>
);
export function ModelConnections({
  connections,
  transport,
  refresh,
}: {
  connections: ModelConnection[];
  transport: Transport;
  refresh: () => Promise<void>;
}) {
  const [kind, setKind] = useState("provider");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const api = createApi(transport).api.admin["model-connections"];
  async function save(action: () => Promise<unknown>) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>供应商连接</summary>
      {connections.map((c) => (
        <div key={c.id} className="my-3 flex min-w-0 flex-col gap-2 break-all">
          <strong>{c.name}</strong>
          <span>网关供应商：{c.gatewayProvider}</span>
          {c.kind !== "workers-ai" && (
            <span>
              {c.bindingVerified ? "凭据绑定已核验" : "等待配置服务核验"} · 连接 ID：{c.id}
            </span>
          )}
          {c.kind === "custom" && (
            <span>上游：{c.upstream}（在 Cloudflare 登记主机，路径由 TaskRelay 追加）</span>
          )}
          {c.keyAlias && <span>Cloudflare 密钥别名：{c.keyAlias}</span>}
          <Field label={c.name + " · 请求发起区域"}>
            <NativeSelect
              disabled={busy}
              value={c.defaultRegion}
              onChange={(e) => {
                const defaultRegion = e.target.value as EgressRegion;
                void save(() =>
                  rpcData(
                    api[":id"].region.$put({
                      param: { id: c.id },
                      json: { defaultRegion, expectedRegion: c.defaultRegion },
                    }),
                  ),
                ).catch((e: Error) => setError(e.message));
              }}
            >
              {regions}
            </NativeSelect>
          </Field>
        </div>
      ))}
      <form
        className="my-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fields = new window.FormData(form);
          void save(async () => {
            const input = connectionInputSchema.parse({
              name: fields.get("name"),
              defaultRegion: fields.get("region"),
              kind,
              ...(kind === "provider"
                ? { provider: fields.get("provider") }
                : kind === "custom"
                  ? { upstream: fields.get("upstream") }
                  : {}),
            });
            await rpcData(api.$post({ json: input }));
            form.reset();
            setKind("provider");
          }).catch((e: Error) => setError(e.message));
        }}
      >
        <fieldset disabled={busy} className="flex flex-col gap-3">
          <Field label="连接名称">
            <Input name="name" required maxLength={80} />
          </Field>
          <Field label="连接类型">
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="provider">第三方供应商</option>
              <option value="custom">自定义兼容服务</option>
              <option value="workers-ai">Workers AI</option>
            </NativeSelect>
          </Field>
          {kind === "provider" && (
            <Field label="供应商">
              <NativeSelect name="provider">
                {["openai", "deepseek", "groq", "openrouter", "grok"].map((p) => (
                  <option key={p} value={p}>
                    {p === "grok" ? "xAI" : p}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {kind === "custom" && (
            <Field
              label="公网 HTTPS 服务地址"
              hint="包含供应商的接口前缀，例如 https://example.com/v1。"
            >
              <Input required type="url" name="upstream" />
            </Field>
          )}
          <Field label="默认请求发起区域">
            <NativeSelect name="region">{regions}</NativeSelect>
          </Field>
          <Button type="submit" disabled={busy}>
            创建连接
          </Button>
        </fieldset>
      </form>
      {error && <ErrorText error={error} />}
    </details>
  );
}
