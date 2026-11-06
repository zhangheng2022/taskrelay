/** 模型表单由 RHF 持有编辑草稿，Zod 校验与服务端保持一致；后台刷新不能覆盖正在编辑的值。 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  modelInputSchema,
  type ModelInput,
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

const presets = {
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  bailian: { name: "百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  custom: { name: "", baseUrl: "" },
};
export function ModelDialog({
  value,
  transport,
  onClose,
  onSaved,
}: {
  value: ModelProfile | null;
  transport: Transport;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const form = useForm<z.input<typeof modelInputSchema>, unknown, ModelInput>({
    resolver: zodResolver(modelInputSchema),
    defaultValues: {
      name: value?.name ?? "",
      baseUrl: value?.baseUrl ?? "",
      protocol: value?.protocol ?? "chat",
      model: value?.model ?? "",
      apiKey: "",
      contextTokens: value?.contextTokens ?? 16000,
      outputTokens: value?.outputTokens ?? 4096,
      inputPrice: value?.inputPrice ?? null,
      outputPrice: value?.outputPrice ?? null,
    },
  });
  const { errors, isSubmitting: busy } = form.formState;
  const submit = form.handleSubmit(async (input) => {
    setError("");
    try {
      if (!value && !input.apiKey) {
        form.setError("apiKey", { message: "请填写 API Key" });
        return;
      }
      const models = createApi(transport).api.admin.models;
      await rpcData(
        value
          ? models[":id"].$put({ param: { id: value.id }, json: input })
          : models.$post({ json: input }),
      );
      form.setValue("apiKey", "");
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      form.setValue("apiKey", "");
    }
  });
  const price = { setValueAs: (value: string) => (value === "" ? null : Number(value)) };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{value ? "编辑模型服务" : "添加模型服务"}</DialogTitle>
          <DialogDescription>保存后请运行能力测试。服务地址必须是公网 HTTPS。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }}
        >
          <FieldGroup>
            <Field label="服务商">
              <NativeSelect
                defaultValue="custom"
                onChange={(event) => {
                  const preset = presets[event.target.value as keyof typeof presets];
                  form.setValue("name", preset.name, { shouldDirty: true });
                  form.setValue("baseUrl", preset.baseUrl, { shouldDirty: true });
                }}
              >
                {Object.entries(presets).map(([id, preset]) => (
                  <option key={id} value={id}>
                    {preset.name || "自定义兼容服务"}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="配置名称" error={errors.name?.message}>
                <Input required {...form.register("name")} />
              </Field>
              <Field label="API 协议" error={errors.protocol?.message}>
                <NativeSelect {...form.register("protocol")}>
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </NativeSelect>
              </Field>
            </FieldGroup>
            <Field
              label="Base URL"
              hint="例如 https://api.openai.com/v1。也可粘贴与协议对应的完整接口地址。"
              error={errors.baseUrl?.message}
            >
              <Input
                required
                type="url"
                placeholder="https://api.example.com/v1"
                {...form.register("baseUrl")}
              />
            </Field>
            <Field label="上下文预算（token，保守估计）" error={errors.contextTokens?.message}>
              <Input
                type="number"
                min={8192}
                max={200000}
                {...form.register("contextTokens", { valueAsNumber: true })}
              />
            </Field>
            <Field label="输出预留（token）" error={errors.outputTokens?.message}>
              <Input
                type="number"
                min={512}
                max={8192}
                {...form.register("outputTokens", { valueAsNumber: true })}
              />
            </Field>
            <Field label="模型名称" error={errors.model?.message}>
              <Input required placeholder="填写服务商提供的模型标识" {...form.register("model")} />
            </Field>
            <Field
              label="API Key"
              hint={
                value
                  ? "留空保留现有密钥。更新配置会创建新版本。"
                  : "密钥只会提交到你的 Workers，保存后不会显示明文。"
              }
              error={errors.apiKey?.message}
            >
              <Input
                type="password"
                autoComplete="new-password"
                required={!value}
                {...form.register("apiKey")}
              />
            </Field>
            <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="输入单价 / 百万 tokens（可选）" error={errors.inputPrice?.message}>
                <Input type="number" min="0" step="any" {...form.register("inputPrice", price)} />
              </Field>
              <Field label="输出单价 / 百万 tokens（可选）" error={errors.outputPrice?.message}>
                <Input type="number" min="0" step="any" {...form.register("outputPrice", price)} />
              </Field>
            </FieldGroup>
            {errors.root?.message && <p role="alert">{errors.root.message}</p>}
            {error && <ErrorText error={error} />}
          </FieldGroup>
          <div className="form-footer">
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                form.reset();
                onClose();
              }}
            >
              取消
            </Button>
            <Button disabled={busy}>{busy ? "正在保存…" : "保存配置"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
