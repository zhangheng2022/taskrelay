/** 服务页只在接入和排错时展示网关登记信息；配置状态来自服务端核验。 */
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Field } from "./form-field";
import { ErrorText } from "./feedback";

const labels = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  openrouter: "OpenRouter",
  grok: "xAI",
  "workers-ai": "Workers AI",
  custom: "自定义服务",
};
const regionNames = { auto: "自动", us: "美国", eu: "欧盟" };
const regions = Object.entries(regionNames).map(([key, name]) => (
  <SelectItem key={key} value={key}>
    {name}
  </SelectItem>
));

export function ModelConnections({
  connections,
  transport,
  refresh,
}: {
  connections: ModelConnection[];
  transport: Transport;
  refresh: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<keyof typeof labels>("openai");
  const [expanded, setExpanded] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const api = createApi(transport).api.admin["model-connections"];
  async function save(action?: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action?.();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="section-heading">
        <h2>管理服务</h2>
        <Button disabled={adding} onClick={() => setAdding(true)}>
          添加服务
        </Button>
      </div>
      {connections.map((c) => (
        <article key={c.id} className="flex min-w-0 flex-col gap-2 border-b pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="break-all">{c.name}</strong>
            <span>{regionNames[c.defaultRegion]}</span>
            <span>{c.bindingVerified ? "已配置" : "待配置"}</span>
            <Button
              variant="ghost"
              aria-expanded={expanded === c.id}
              onClick={() => setExpanded(expanded === c.id ? "" : c.id)}
            >
              {c.bindingVerified ? "服务设置" : "查看配置步骤"}
            </Button>
          </div>
          {expanded === c.id && (
            <div className="flex min-w-0 flex-col gap-3 break-all">
              {!c.bindingVerified && c.kind !== "workers-ai" && (
                <ol className="list-decimal pl-5">
                  {c.kind === "custom" && (
                    <li>
                      在 Cloudflare 的 AI Gateway → Custom Providers 添加服务。标识填{" "}
                      <code>{c.gatewayProvider.replace(/^custom-/, "")}</code>，地址填{" "}
                      <code>{new URL(c.upstream).origin}</code>。TaskRelay 会追加接口路径。
                    </li>
                  )}
                  <li>
                    在 AI Gateway 的 taskrelay 网关打开 Provider Keys，选择{" "}
                    <code>{c.gatewayProvider}</code>，录入服务商密钥，别名填{" "}
                    <code>{c.keyAlias}</code>。
                  </li>
                  <li>
                    在已配置管理权限的项目目录运行{" "}
                    <code>node scripts/prepare-model-gateway.mjs --verify-connection {c.id}</code>
                    ，再点「刷新状态」。
                  </li>
                </ol>
              )}
              {!c.bindingVerified && (
                <Button variant="outline" disabled={busy} onClick={() => void save()}>
                  刷新状态
                </Button>
              )}
              <Select
                disabled={busy}
                value={c.defaultRegion}
                onValueChange={(region) => {
                  const defaultRegion = region as EgressRegion;
                  void save(async () => {
                    await rpcData(
                      api[":id"].region.$put({
                        param: { id: c.id },
                        json: { defaultRegion, expectedRegion: c.defaultRegion },
                      }),
                    );
                  }).catch((e: Error) => setError(e.message));
                }}
              >
                <Field label={c.name + " · 请求发起区域"}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </Field>
                <SelectContent position="popper" align="start">
                  <SelectGroup>{regions}</SelectGroup>
                </SelectContent>
              </Select>
              <details>
                <summary>技术详情</summary>
                <p>连接 ID：{c.id}</p>
                <p>网关标识：{c.gatewayProvider}</p>
                {c.keyAlias && <p>密钥别名：{c.keyAlias}</p>}
                {c.kind === "custom" && <p>接口地址：{c.upstream}</p>}
              </details>
            </div>
          )}
        </article>
      ))}
      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new window.FormData(e.currentTarget);
            void save(async () => {
              const urlField = data.get("upstream"),
                nameField = data.get("name");
              const upstream = typeof urlField === "string" ? urlField.trim() : "";
              const name =
                (typeof nameField === "string" ? nameField.trim() : "") ||
                (source === "custom" ? new URL(upstream).hostname : labels[source]);
              const input = connectionInputSchema.parse({
                name,
                defaultRegion: data.get("region"),
                ...(source === "custom"
                  ? { kind: "custom", upstream }
                  : source === "workers-ai"
                    ? { kind: "workers-ai" }
                    : { kind: "provider", provider: source }),
              });
              const created = await rpcData(api.$post({ json: input }));
              setExpanded(created.id);
              setAdding(false);
              setSource("openai");
            }).catch((e: Error) => setError(e.message));
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-3">
            <Select
              disabled={busy}
              value={source}
              onValueChange={(value) => setSource(value as keyof typeof labels)}
            >
              <Field label="服务提供方">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </Field>
              <SelectContent position="popper" align="start">
                <SelectGroup>
                  {Object.entries(labels).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {source === "custom" && (
              <Field label="公网 HTTPS 服务地址" hint="包含接口前缀，例如 https://example.com/v1。">
                <Input type="url" name="upstream" required />
              </Field>
            )}
            <details>
              <summary>高级设置</summary>
              <Field label="服务名称">
                <Input name="name" maxLength={80} placeholder="默认使用提供方或网站名称" />
              </Field>
              <Select name="region" defaultValue="auto" disabled={busy}>
                <Field label="默认请求发起区域">
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </Field>
                <SelectContent position="popper" align="start">
                  <SelectGroup>{regions}</SelectGroup>
                </SelectContent>
              </Select>
            </details>
            <div className="flex gap-2">
              <Button type="submit">保存服务</Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                取消
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {error && <ErrorText error={error} />}
    </section>
  );
}
