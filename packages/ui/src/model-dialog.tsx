import { useConfirmation, useSettingsDirty } from "./settings-support";
/** 模型表单由 RHF 持有编辑草稿，Zod 校验与服务端保持一致；后台刷新不能覆盖正在编辑的值。 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  modelInputSchema,
  type ModelInput,
  type ModelConnection,
  type ModelProfile,
  type Transport,
} from "../../contracts/src/index";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Button } from "./components/ui/button";
import { FieldGroup } from "./components/ui/field";
import { Field } from "./form-field";
import { ErrorText } from "./feedback";
import { createApi, rpcData } from "./api";

const formSchema = modelInputSchema
  .safeExtend({ name: z.string().trim().max(80), model: z.string().trim().min(1).max(200) })
  .transform((v) => ({ ...v, name: v.name || v.model.slice(0, 80) }));
export function ModelDialog({
  value,
  connections,
  transport,
  onClose,
  onSaved,
}: {
  value: ModelProfile | null;
  connections: ModelConnection[];
  transport: Transport;
  onClose: () => void;
  onSaved: (saved: { id: string; version: number }) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [expectedVersion] = useState(value?.managementVersion ?? 1);
  const form = useForm<z.input<typeof formSchema>, unknown, ModelInput>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: value?.name ?? "",
      connectionId: value?.connectionId ?? (connections.length === 1 ? connections[0].id : ""),
      region: value?.region ?? "inherit",
      protocol: "responses",
      model: value?.model ?? "",
      contextTokens: value?.contextTokens ?? 16000,
      outputTokens: value?.outputTokens ?? 4096,
      inputPrice: value?.inputPrice ?? null,
      outputPrice: value?.outputPrice ?? null,
    },
  });
  const { errors, isSubmitting: busy, isDirty } = form.formState;
  useSettingsDirty(isDirty);
  const { ask, confirmation } = useConfirmation();
  async function close() {
    if (!isDirty || (await ask("放弃模型修改？", "未保存的内容会丢失。", "放弃修改"))) {
      form.reset();
      onClose();
    }
  }
  const submit = form.handleSubmit(async (input) => {
    setError("");
    try {
      if (!navigator.onLine) throw Error("NETWORK_OFFLINE");
      const models = createApi(transport).api.admin.models;
      const saved = await rpcData(
        value
          ? models[":id"].$put({ param: { id: value.id }, json: { ...input, expectedVersion } })
          : models.$post({ json: input }),
      );
      await onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    }
  });
  const price = { setValueAs: (value: string) => (value === "" ? null : Number(value)) };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          void close().catch(() => {});
        }
      }}
    >
      {confirmation}
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{value ? "编辑模型" : "添加模型"}</DialogTitle>
          <DialogDescription>保存后会测试问答、工具调用和结构化输出。</DialogDescription>
        </DialogHeader>
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 表单捕获输入法 Enter 冒泡，避免中文组合输入误提交。 */}
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            void submit(event).catch((error: Error) => setError(error.message));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }}
        >
          <FieldGroup>
            <Field
              label="选择服务"
              hint={connections.length ? undefined : "请先添加一个服务。"}
              error={errors.connectionId?.message}
            >
              <NativeSelect disabled={busy} required {...form.register("connectionId")}>
                <option value="">请选择服务</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="模型名" error={errors.model?.message}>
              <Input
                disabled={busy}
                required
                placeholder="填写服务商提供的模型标识"
                {...form.register("model")}
              />
            </Field>
            <details>
              <summary>高级设置</summary>
              <Field label="请求发起区域">
                <NativeSelect disabled={busy} {...form.register("region")}>
                  <option value="inherit">跟随连接</option>
                  <option value="auto">自动</option>
                  <option value="us">美国</option>
                  <option value="eu">欧盟</option>
                </NativeSelect>
              </Field>

              <Field label="显示名称" error={errors.name?.message}>
                <Input disabled={busy} placeholder="默认使用模型名称" {...form.register("name")} />
              </Field>
              <Field label="上下文预算（token，保守估计）" error={errors.contextTokens?.message}>
                <Input
                  disabled={busy}
                  type="number"
                  min={8192}
                  max={200000}
                  {...form.register("contextTokens", { valueAsNumber: true })}
                />
              </Field>
              <Field label="输出预留（token）" error={errors.outputTokens?.message}>
                <Input
                  disabled={busy}
                  type="number"
                  min={512}
                  max={8192}
                  {...form.register("outputTokens", { valueAsNumber: true })}
                />
              </Field>
              <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="输入单价 / 百万 tokens（可选）" error={errors.inputPrice?.message}>
                  <Input
                    disabled={busy}
                    type="number"
                    min="0"
                    step="any"
                    {...form.register("inputPrice", price)}
                  />
                </Field>
                <Field label="输出单价 / 百万 tokens（可选）" error={errors.outputPrice?.message}>
                  <Input
                    disabled={busy}
                    type="number"
                    min="0"
                    step="any"
                    {...form.register("outputPrice", price)}
                  />
                </Field>
              </FieldGroup>
            </details>
            {errors.root?.message && <p role="alert">{errors.root.message}</p>}
            {error && <ErrorText error={error} />}
          </FieldGroup>
          <div className="form-footer">
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                void close().catch(() => {});
              }}
            >
              取消
            </Button>
            <Button disabled={busy}>{busy ? "正在保存…" : "保存并测试"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
