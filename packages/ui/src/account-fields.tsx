import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { FieldGroup, Field as ControlField, FieldLabel, FieldDescription } from './components/ui/field';
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from './components/ui/input-group';
import { Field } from './form-field';

/** 账号设置与聊天确认共用的编辑表单。秘密仅保留在当前表单内存，不写入浏览器存储。 */
export interface AccountFieldsValue {
  name: string;
  origin: string;
  businessDomains: string;
  loginOrigins: string;
  username: string;
  password: string;
}
export const emptyAccountFields: AccountFieldsValue = {
  name: '', origin: '', businessDomains: '', loginOrigins: '', username: '', password: '',
};
export function accountFieldsBody(value: AccountFieldsValue) {
  const list = (text: string) => [...new Set(text.split(/[\s,，]+/).filter(Boolean))];
  const businessDomains = list(value.businessDomains), loginOrigins = list(value.loginOrigins);
  try { const url = new URL(value.origin); if (!businessDomains.length) businessDomains.push(url.hostname); if (!loginOrigins.length) loginOrigins.push(url.origin); } catch { /* 无效地址由表单与服务端校验，不在渲染时抛错。 */ }
  return { ...value, name: value.name.trim(), origin: value.origin.trim(),
    businessDomains, loginOrigins };
}
export function AccountFields({ value, onChange, disabled, keepPassword = false }: {
  value: AccountFieldsValue; onChange: (value: AccountFieldsValue) => void;
  disabled?: boolean; keepPassword?: boolean;
}) {
  const passwordId = useId(), [visible, setVisible] = useState(false);
  const change = (field: keyof AccountFieldsValue, next: string) => onChange({ ...value, [field]: next });
  return <FieldGroup>
    <Field label="账号名称"><Input required maxLength={80} value={value.name} disabled={disabled} onChange={e => change('name', e.target.value)}/></Field>
    <Field label="业务网站" hint="填写实际使用的网站地址。"><Input type="url" required maxLength={2000} placeholder="https://example.com" value={value.origin} disabled={disabled} onChange={e => change('origin', e.target.value)}/></Field>
    <Field label="所属业务域名" hint="每行一个精确域名，不包含通配符；留空使用上方网站域名。"><Textarea rows={2} maxLength={4000} placeholder="example.com" value={value.businessDomains} disabled={disabled} onChange={e => change('businessDomains', e.target.value)}/></Field>
    <Field label="关联登录地址" hint="每行一个完整登录来源地址，如 https://login.example.com。留空使用业务网站地址。"><Textarea rows={2} maxLength={8000} placeholder="https://login.example.com" value={value.loginOrigins} disabled={disabled} onChange={e => change('loginOrigins', e.target.value)}/></Field>
    <Field label="用户名"><Input autoComplete="off" maxLength={200} value={value.username} disabled={disabled} onChange={e => change('username', e.target.value)}/></Field>
    <ControlField data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={passwordId}>密码</FieldLabel>
      <InputGroup>
        <InputGroupInput id={passwordId} type={visible ? 'text' : 'password'} autoComplete="new-password" maxLength={2000} value={value.password} disabled={disabled} aria-describedby={`${passwordId}-hint`} onChange={e => change('password', e.target.value)}/>
        <InputGroupAddon align="inline-end"><InputGroupButton size="icon-sm" disabled={disabled} aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(v => !v)}>{visible ? <EyeOff/> : <Eye/>}</InputGroupButton></InputGroupAddon>
      </InputGroup>
      <FieldDescription id={`${passwordId}-hint`}>{keepPassword ? '留空保留现有密码，填写新密码后需重新验证。' : '确认保存后加密存储；验证码继续在聊天中提供。'}</FieldDescription>
    </ControlField>
  </FieldGroup>;
}
