/** 设置共用确认、草稿登记与写入反馈。敏感草稿只在组件内存中，提交不自动重试。 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./components/ui/alert-dialog";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Input } from "./components/ui/input";
import { FormSelect } from "./form-select";
import { SelectItem } from "./components/ui/select";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./components/ui/empty";
import { ErrorText } from "./feedback";

export const SettingsDrafts = createContext<((id: string, dirty: boolean) => void) | null>(null);
export function useSettingsDirty(dirty: boolean) {
  const register = useContext(SettingsDrafts),
    id = useId();
  useEffect(() => {
    register?.(id, dirty);
    return () => register?.(id, false);
  }, [register, id, dirty]);
}
export function useConfirmation() {
  const [dialog, setDialog] = useState<{
    title: string;
    description: string;
    action: string;
  } | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(
    () => () => {
      pending.current?.(false);
    },
    [],
  );
  const ask = useCallback(
    (title: string, description: string, action = "确认") =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setDialog({ title, description, action });
      }),
    [],
  );
  const close = (accepted: boolean) => {
    pending.current?.(accepted);
    pending.current = null;
    setDialog(null);
  };
  return {
    ask,
    confirmation: (
      <AlertDialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) close(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.title}</AlertDialogTitle>
            <AlertDialogDescription>{dialog?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => close(true)}>{dialog?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
export function useSettingsAction() {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const flight = useRef(false);
  async function act(
    id: string,
    write: () => Promise<unknown>,
    refresh?: () => Promise<unknown>,
    message = "已保存",
  ) {
    if (flight.current) return false;
    if (!navigator.onLine) {
      setError("NETWORK_OFFLINE");
      return false;
    }
    flight.current = true;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await write();
      setNotice(message);
      if (refresh) {
        try {
          await refresh();
        } catch {
          setNotice(`${message}，但列表刷新失败，请刷新后核对。`);
        }
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      flight.current = false;
      setBusy("");
    }
  }
  return {
    busy,
    act,
    feedback: (
      <>
        {error && <ErrorText error={error} />}
        {notice && (
          <Alert>
            <AlertDescription role="status">{notice}</AlertDescription>
          </Alert>
        )}
      </>
    ),
  };
}
export function SettingsSearch({
  value,
  onChange,
  state,
  onState,
  label = "搜索",
  options = [
    ["all", "全部状态"],
    ["enabled", "已启用"],
    ["disabled", "已停用"],
  ],
}: {
  value: string;
  onChange: (v: string) => void;
  state: string;
  onState: (v: string) => void;
  label?: string;
  options?: string[][];
}) {
  const id = useId();
  return (
    <FieldGroup className="grid grid-cols-1 items-end gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={label}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + "state"}>筛选状态</FieldLabel>
        <FormSelect id={id + "state"} value={state} onValueChange={onState}>
          {options.map(([key, name]) => (
            <SelectItem key={key} value={key}>
              {name}
            </SelectItem>
          ))}
        </FormSelect>
      </Field>
    </FieldGroup>
  );
}
export function SettingsEmpty({
  title = "没有匹配的结果",
  description = "试试其他关键词或筛选条件。",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
