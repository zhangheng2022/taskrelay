import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription } from "./components/ui/alert";
export const labels: Record<string, string> = {
  pending_validation: "待试运行",
  active: "已启用",
  paused: "已暂停",
  needs_input: "待补充",
  queued: "排队中",
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
    PUBLIC_HTTPS_REQUIRED:"请填写公网 HTTPS 网站地址，不要包含用户名、密码或非标准端口。",
    PRIVATE_ADDRESS_BLOCKED:"不能访问本机或私有网络地址，请改用公网网站。",
    ORIGIN_NOT_AUTHORIZED:"网站不在允许访问的站点中，请核对地址和授权范围。",
    ENTRY_ORIGIN_NOT_ALLOWED:"网站不在允许访问的站点中，请核对地址和授权范围。",
    THREAD_VERSION_CONFLICT:"会话已在另一处更新，请刷新后重新发送。", DRAFT_VERSION_CONFLICT:"草稿已变更，请重新核对确认卡。",
    THREAD_NOT_FOUND:"会话已删除或过期，请重新打开。", TURN_STALE:"这轮回复已失效，请查看最新会话。",
    TURN_OUTCOME_UNKNOWN:"本轮结果无法确认，系统不会自动重复请求。", MEMORY_CHANGED:"记忆已更新，请重新发送本轮问题。",
    CONTEXT_BUDGET_EXCEEDED:"这轮内容超过模型上下文预算，请缩短输入或调整模型预算。", MEMORY_LIMIT:"记忆已达100条，请先删除不再需要的内容。",
    MAINTENANCE:"服务维护中，请稍后再试。", CLIENT_UPGRADE_REQUIRED:"请安装最新客户端。", DEVICE_UPGRADE_REQUIRED:"设备需要完成协议升级。",
    LOCAL_HISTORY_UNRESOLVED:"本机仍有未同步的执行记录，请先完成恢复和核查。",
    AUTH_REQUIRED: "请登录后继续。", AUTH_FAILED:"登录失败，请检查输入后重试。", AUTH_NOT_CONFIGURED:"登录服务尚未配置，请联系管理员。",
    INVALID_EMAIL_OR_PASSWORD:"邮箱或密码不正确。", EMAIL_NOT_VERIFIED:"请先点击验证邮件中的链接。", EMAIL_VERIFICATION_REQUIRED:"请先验证邮箱。",
    PASSWORD_TOO_SHORT:"密码至少需要 12 位。", INVALID_TOKEN:"链接无效或已过期，请重新申请。",
    USER_DISABLED:"账号已停用，请联系管理员。", ADMIN_REQUIRED:"此操作仅限管理员。", RESOURCE_NOT_FOUND:"内容不存在或无权访问。",
    REGISTRATION_CLOSED:"公开注册尚未开放。", RATE_LIMITED:"操作过于频繁，请稍后再试。",
    TURNSTILE_REQUIRED:"请先完成人机验证。", TURNSTILE_REJECTED:"验证已过期，请重新验证。", TURNSTILE_NOT_CONFIGURED:"注册验证尚未配置。",
    EMAIL_NOT_CONFIGURED:"邮件服务尚未配置。", EMAIL_DELIVERY_FAILED:"邮件暂时发送失败，请稍后重试。",
    CHAT_QUOTA_EXCEEDED:"今日对话额度已用完，额度将在上海时间零点重置。",
    MODEL_QUOTA_EXCEEDED:"个人或公共模型额度已用完，请查看额度或联系管理员。",
    RUN_QUOTA_EXCEEDED:"今日执行额度已用完，额度将在上海时间零点重置。",
    PLATFORM_DAILY_LIMIT:"今日平台免费预算已用完，预算在北京时间每日 08:00 重置。",
    PAGE_NETWORK_FAILED:"执行器无法安全连接目标网站，请检查网站及网络后重新发起运行。",
    QUEUE_LIMIT:"排队任务已达上限，请等待已有任务完成或取消排队。",
    SCHEDULE_QUOTA_EXCEEDED:"启用的周期任务已达上限，请先暂停其他周期任务。",
    ACCOUNT_MIGRATION_BLOCKED:"账号仍在执行、等待核查，或目标设备不可用，暂不能迁移。",
    CANNOT_DISABLE_SELF:"不能停用当前管理员账号。", DEVICE_SCOPE_REJECTED:"执行器不能访问任务管理功能。",

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
    ACCESS_REQUIRED: "请登录网站后刷新页面。",
    DEVICE_UNAUTHORIZED: "设备授权已失效，请重新连接。",
    PAIRING_EXPIRED: "设备配对链接已过期。如仍需连接，请在执行器中重新发起配对；已授权设备和任务结果不受影响。",
    MODEL_CAPABILITIES_REQUIRED: "模型尚未通过能力测试，请到设置中测试。",
    TRIAL_REQUIRED: "请先完成一次成功的试运行，再启用调度。",
    CHALLENGE_STALE: "这条协助请求已过期或已回复，请刷新当前任务。",
    EXPLICIT_APPROVAL_REQUIRED: "请核对具体操作，再输入“确认执行”。",
    CHALLENGE_UNSUPPORTED: "此验证无法通过当前对话通道完成。",
    REPLY_SPAN_INVALID:
      "未能从回复中提取有效信息，请核对当前验证要求后重新输入。",
    REPLY_INVALID: "回复包含无法填写的字符或过长，请只输入当前步骤需要的信息。",
    CONFIRMATION_REQUIRED: "请先完成扫码或外部确认，再点击“已扫码，检查状态”。",
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
