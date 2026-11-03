import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription } from "./components/ui/alert";
export const labels: Record<string, string> = {
  pending_validation: "待试运行",
  active: "已启用",
  paused: "已暂停",
  needs_input: "待补充",
  queued: "等待设备",
  running: "正在执行",
  waiting_user: "需要协助",
  verifying: "正在核验",
  succeeded: "已完成",
  failed: "执行失败",
  unknown: "结果待核查",
  cancelled: "已取消",
  expired: "已过期",
};
export function formatDate(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      }).format(new Date(value))
    : "—";
}
export function Status({ value }: { value: string }) {
  return (
    <Badge
      variant={
        value === "failed" || value === "unknown" ? "destructive" : "outline"
      }
    >
      {labels[value] ?? value}
    </Badge>
  );
}
export function ErrorText({ error }: { error: string }) {
  const friendly: Record<string, string> = {
    MODEL_HTTP_403_UNSUPPORTED_REGION:
      "请求被模型服务判定来自不支持的地区。请使用支持当前使用地区的兼容服务，或联系服务商确认可用性。",
    MODEL_HTTP_403_PERMISSION:
      "模型服务拒绝访问。请检查 API Key 所属项目和模型权限。",
    MODEL_HTTP_403_ORGANIZATION_RESTRICTED:
      "模型服务限制了当前组织，请检查服务商控制台。",
    MODEL_HTTP_403_ACCOUNT_RESTRICTED: "模型服务限制了当前账号，请联系服务商。",
    MODEL_HTTP_403_GATEWAY_DENIED:
      "模型服务网关拒绝了请求，请检查接口地址及服务商访问策略。",
    MODEL_HTTP_403: "模型服务返回 403，请检查服务商地区支持、账号及模型权限。",
    MODEL_HTTP_401_INVALID_KEY: "API Key 未通过服务商验证，请重新检查密钥。",
    MODEL_HTTP_404_MODEL_UNAVAILABLE:
      "模型不存在或当前项目无访问权限，请填写服务商 API 实际提供的模型名称。",
    MODEL_HTTP_429_QUOTA: "模型服务额度不足，请检查服务商账户的额度。",
    MODEL_DNS_FAILED: "无法校验模型服务地址，请检查域名或稍后重试。",
    MODEL_PROTOCOL_MISMATCH:
      "接口路径与所选协议不一致，请使用对应的 Base URL。",
    MODEL_BASE_URL_INVALID: "Base URL 不能包含查询参数或片段。",
    MODEL_REDIRECT_BLOCKED: "模型服务返回了重定向，请填写最终 HTTPS 接口地址。",
    ACCESS_REQUIRED: "请通过 Cloudflare Access 登录后刷新页面。",
    DEVICE_UNAUTHORIZED: "设备授权已失效，请重新连接。",
    MODEL_CAPABILITIES_REQUIRED: "模型尚未通过能力测试，请到设置中测试。",
    TRIAL_REQUIRED: "请先完成一次成功的试运行，再启用调度。",
    CHALLENGE_STALE: "这条协助请求已过期或已回复，请刷新当前任务。",
    EXPLICIT_APPROVAL_REQUIRED: "请核对具体操作，再输入“确认执行”。",
    CHALLENGE_UNSUPPORTED: "此验证无法通过当前对话通道完成。",
    OFFLINE: "暂时无法连接云端。已保留缓存，连接恢复后自动刷新。",
    MODEL_INVALID_JSON: "模型返回的格式不正确，请检查模型配置后重试。",
    MODEL_EGRESS_TIMEOUT: "模型回复超时，输入已保留。请稍后重试。",
    MODEL_CALL_OUTCOME_UNKNOWN: "模型请求结果暂时无法确认，请稍后再试。",
    VERSION_CONFLICT: "任务版本已更新，请返回任务对话，核对最新配置后再修改。",
  };
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {friendly[error] ?? `操作未完成：${error}。请检查配置后重试。`}
      </AlertDescription>
    </Alert>
  );
}
