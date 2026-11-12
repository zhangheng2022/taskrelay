/** 设置分组导航与草稿边界；宿主拥有 URL、主题及聊天清理流程。 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { Snapshot, Transport } from "../../contracts/src/index";
import { QueryBoundary } from "./queries";
import { Memories } from "./memories";
import { Accounts } from "./accounts";
import { AdminPanel } from "./admin-panel";
import { AccountSecurity } from "./auth-gate";
import { SettingsModels } from "./settings-models";
import { RetentionSettings } from "./settings-retention";
import { SettingsDrafts, useConfirmation } from "./settings-support";
import { Button } from "./components/ui/button";
import { FormSelect } from "./form-select";
import { SelectItem } from "./components/ui/select";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { ErrorText } from "./feedback";
import { cn } from "./lib/utils";
const groups = [
  {
    name: "个人设置",
    admin: false,
    items: [
      ["general", "通用"],
      ["security", "登录安全"],
      ["accounts", "站点账号"],
      ["memories", "任务记忆"],
    ],
  },
  {
    name: "管理员设置",
    admin: true,
    items: [
      ["models", "模型服务"],
      ["devices", "执行设备"],
      ["users", "用户管理"],
      ["operations", "运行维护"],
      ["data", "数据保留"],
    ],
  },
] as const;
type Theme = "system" | "light" | "dark";
type Props = {
  transport: Transport;
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  section?: string;
  navigate?: (section: string) => void;
  theme?: Theme;
  setTheme?: (theme: Theme) => void;
  leaveGuard?: MutableRefObject<(() => Promise<boolean>) | null>;
  onCleanup?: () => void;
};
export function Settings(props: Props) {
  return (
    <QueryBoundary owner={props.transport}>
      <SettingsContent {...props} />
    </QueryBoundary>
  );
}
function SettingsContent({
  transport,
  snapshot,
  refresh,
  section,
  navigate,
  theme = "system",
  setTheme,
  leaveGuard,
  onCleanup,
}: Props) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const [local, setLocal] = useState("general");
  const visible = groups.filter((g) => !g.admin || snapshot.me?.role === "admin");
  const requested = section ?? local;
  const tab = visible.flatMap((g) => [...g.items]).some(([id]) => id === requested)
    ? requested
    : "general";
  const index = requested === "index";
  const drafts = useRef(new Set<string>());
  const register = useCallback((id: string, dirty: boolean) => {
    if (dirty) drafts.current.add(id);
    else drafts.current.delete(id);
  }, []);
  const { ask, confirmation } = useConfirmation();
  const canLeave = useCallback(
    async () =>
      !drafts.current.size ||
      (await ask("放弃未保存的修改？", "离开后，当前表单中未保存的内容会被丢弃。", "放弃修改")),
    [ask],
  );
  useEffect(() => {
    if (leaveGuard) leaveGuard.current = canLeave;
    const before = (e: BeforeUnloadEvent) => {
      if (drafts.current.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      if (leaveGuard) leaveGuard.current = null;
      window.removeEventListener("beforeunload", before);
    };
  }, [canLeave, leaveGuard]);
  async function go(id: string) {
    if (navigate) navigate(id);
    else if (await canLeave()) setLocal(id);
  }
  return (
    <SettingsDrafts.Provider value={register}>
      <div className="settings-layout">
        {confirmation}
        {!online && (
          <div className="col-span-full">
            <ErrorText error="NETWORK_OFFLINE" />
          </div>
        )}
        <nav
          aria-label="设置分类"
          className={cn("settings-navigation", !index && "settings-navigation-desktop")}
        >
          {visible.map((group) => (
            <section key={group.name} className="flex flex-col gap-1">
              <h2 className="px-3 pb-2 text-xs font-medium text-muted-foreground">{group.name}</h2>
              {group.items.map(([id, label]) => (
                <Button
                  key={id}
                  variant={tab === id && !index ? "secondary" : "ghost"}
                  className="justify-start"
                  aria-current={tab === id && !index ? "page" : undefined}
                  onClick={() => void go(id)}
                >
                  <span className="flex-1 text-left">{label}</span>
                  <ChevronRight data-icon="inline-end" />
                </Button>
              ))}
            </section>
          ))}
        </nav>
        <section
          className={cn("settings-detail", index && "settings-detail-desktop")}
          aria-label={visible.flatMap((g) => [...g.items]).find(([id]) => id === tab)?.[1]}
        >
          <Button
            className="settings-back self-start md:hidden"
            variant="ghost"
            onClick={() => void go("index")}
          >
            <ArrowLeft data-icon="inline-start" />
            全部设置
          </Button>
          {tab === "general" ? (
            <>
              <div className="section-heading">
                <div>
                  <h2>通用</h2>
                  <p>管理工作空间外观与个人信息。</p>
                </div>
              </div>
              <dl className="settings-details">
                <div>
                  <dt>登录邮箱</dt>
                  <dd>{snapshot.me?.email || "本地开发账号"}</dd>
                </div>
                <div>
                  <dt>身份</dt>
                  <dd>{snapshot.me?.role === "admin" ? "管理员" : "普通用户"}</dd>
                </div>
              </dl>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="settings-theme">外观</FieldLabel>
                  <FormSelect
                    id="settings-theme"
                    value={theme}
                    onValueChange={(value) => setTheme?.(value as Theme)}
                  >
                    <SelectItem value="system">跟随系统</SelectItem>
                    <SelectItem value="light">浅色</SelectItem>
                    <SelectItem value="dark">深色</SelectItem>
                  </FormSelect>
                  <p className="text-sm text-muted-foreground">立即生效，仅保存在当前浏览器。</p>
                </Field>
              </FieldGroup>
            </>
          ) : tab === "accounts" ? (
            <Accounts snapshot={snapshot} transport={transport} refresh={refresh} />
          ) : tab === "security" ? (
            <>
              <div className="section-heading">
                <div>
                  <h2>登录安全</h2>
                  <p>管理密码和登录会话。</p>
                </div>
              </div>
              <AccountSecurity />
            </>
          ) : tab === "memories" ? (
            <Memories transport={transport} />
          ) : tab === "models" ? (
            <SettingsModels snapshot={snapshot} transport={transport} refresh={refresh} />
          ) : tab === "data" ? (
            <RetentionSettings transport={transport} onCleanup={onCleanup} />
          ) : (
            <AdminPanel
              transport={transport}
              section={tab as "devices" | "users" | "operations"}
              currentUserId={snapshot.me?.id}
            />
          )}
        </section>
      </div>
    </SettingsDrafts.Provider>
  );
}
