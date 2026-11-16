import { ChevronDown } from "lucide-react";
import {
  reasoningEffortSchema,
  type ModelCapabilities,
  type ModelProfile,
  type ReasoningEffort,
} from "../../contracts/src/index";
import { InputGroupButton } from "./components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./components/ui/dropdown-menu";

export function canUseModel(model: ModelProfile) {
  return (
    model.enabled !== false &&
    model.capabilities.connection &&
    model.capabilities.tools &&
    model.capabilities.structured !== "none"
  );
}

export function ModelSelector({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelProfile[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const selected = models.find((m) => m.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InputGroupButton
          disabled={disabled}
          aria-label="使用的模型"
          size="sm"
          variant="outline"
          className="min-w-0 max-w-full rounded-full"
        >
          <span className="truncate">
            {selected ? `${selected.name} · ${selected.model}` : "选择模型"}
          </span>
          <ChevronDown data-icon="inline-end" />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>模型服务</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {models.map((m) => (
            <DropdownMenuRadioItem
              key={m.id}
              value={m.id}
              disabled={!canUseModel(m)}
              onSelect={() => {
                // 相同 ID 也可能已有新配置版本；明确重选时交由宿主重新绑定。
                if (m.id === value) onChange(m.id);
              }}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="break-all">
                  {m.name} · {m.model}
                </span>
                <span className="text-xs text-muted-foreground">
                  Responses · v{m.version} ·{" "}
                  {canUseModel(m)
                    ? m.capabilities.structured === "schema"
                      ? "工具调用 / JSON Schema"
                      : "工具调用 / JSON 校验"
                    : m.enabled === false
                      ? "已停用"
                      : "必需能力未通过"}
                </span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  none: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

export function ReasoningEffortSelector({
  efforts,
  value,
  onChange,
  disabled,
}: {
  efforts: ModelCapabilities["reasoningEfforts"];
  value: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
  disabled: boolean;
}) {
  const supported = reasoningEffortSchema.options.filter((effort) => efforts?.[effort]);
  if (!supported.length && !value) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InputGroupButton
          variant="outline"
          size="sm"
          className="shrink-0 rounded-full"
          aria-label="推理强度"
          disabled={disabled}
        >
          {value ? `推理 ${reasoningEffortLabels[value]}` : "模型默认"}
          <ChevronDown data-icon="inline-end" />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuLabel>推理强度</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? "default"}
          onValueChange={(next) =>
            onChange(next === "default" ? null : reasoningEffortSchema.parse(next))
          }
        >
          <DropdownMenuRadioItem value="default">模型默认</DropdownMenuRadioItem>
          {supported.map((effort) => (
            <DropdownMenuRadioItem key={effort} value={effort}>
              {reasoningEffortLabels[effort]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
