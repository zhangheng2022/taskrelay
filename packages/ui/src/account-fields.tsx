import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./components/ui/input";
import {
  FieldGroup,
  Field as ControlField,
  FieldLabel,
  FieldDescription,
} from "./components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "./components/ui/input-group";
import { Field } from "./form-field";

/** 四项账号表单共用于设置与聊天；已有登录来源保留在内部，修改域名时清除旧关联，交服务端重新校验。秘密不写浏览器存储。 */
export interface AccountFieldsValue {
  name: string;
  origin: string;
  businessDomains: string;
  loginOrigins: string;
  username: string;
  password: string;
}
export const emptyAccountFields: AccountFieldsValue = {
  name: "",
  origin: "",
  businessDomains: "",
  loginOrigins: "",
  username: "",
  password: "",
};
export function accountDomain(origin: string) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
export function accountFieldsBody(value: AccountFieldsValue) {
  const list = (text: string) => [...new Set(text.split(/[\s,，]+/).filter(Boolean))];
  const raw = value.origin.trim();
  // 用户只需填写域名。已有完整 origin 保留协议与端口，鉴权与公网校验仍由服务端负责。
  const origin = raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? `https://${raw}` : raw;
  const businessDomains = list(value.businessDomains),
    loginOrigins = list(value.loginOrigins);
  try {
    const url = new URL(origin);
    if (!businessDomains.length) businessDomains.push(url.hostname);
    if (!loginOrigins.length) loginOrigins.push(url.origin);
  } catch {
    /* 无效地址由表单与服务端校验，不在渲染时抛错。 */
  }
  return { ...value, name: value.name.trim(), origin, businessDomains, loginOrigins };
}
export function AccountFields({
  value,
  onChange,
  disabled,
  keepPassword = false,
}: {
  value: AccountFieldsValue;
  onChange: (value: AccountFieldsValue) => void;
  disabled?: boolean;
  keepPassword?: boolean;
}) {
  const passwordId = useId(),
    [visible, setVisible] = useState(false);
  const change = (field: keyof AccountFieldsValue, next: string) =>
    onChange({ ...value, [field]: next });
  return (
    <FieldGroup>
      <Field label="账号名称">
        <Input
          required
          maxLength={80}
          value={value.name}
          disabled={disabled}
          onChange={(e) => change("name", e.target.value)}
        />
      </Field>
      <Field label="域名">
        <Input
          required
          maxLength={2000}
          placeholder="example.com"
          autoCapitalize="none"
          spellCheck={false}
          value={accountDomain(value.origin)}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...value, origin: e.target.value, businessDomains: "", loginOrigins: "" })
          }
        />
      </Field>
      <Field label="账号">
        <Input
          autoComplete="off"
          maxLength={200}
          value={value.username}
          disabled={disabled}
          onChange={(e) => change("username", e.target.value)}
        />
      </Field>
      <ControlField data-disabled={disabled || undefined}>
        <FieldLabel htmlFor={passwordId}>密码</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={passwordId}
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            maxLength={2000}
            value={value.password}
            disabled={disabled}
            aria-describedby={`${passwordId}-hint`}
            onChange={(e) => change("password", e.target.value)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-sm"
              disabled={disabled}
              aria-label={visible ? "隐藏密码" : "显示密码"}
              aria-pressed={visible}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription id={`${passwordId}-hint`}>
          {keepPassword
            ? "留空保留现有密码，填写新密码后需重新验证。"
            : "确认保存后加密存储；验证码继续在聊天中提供。"}
        </FieldDescription>
      </ControlField>
    </FieldGroup>
  );
}
