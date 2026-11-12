import { ChevronDown } from "lucide-react";
import type { ModelProfile } from "../../contracts/src/index";
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
          className="max-w-full"
        >
          <span className="truncate">
            {selected ? `${selected.name} · ${selected.model}` : "选择模型"}
          </span>
          <ChevronDown />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>模型服务</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} disabled={!canUseModel(m)}>
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
