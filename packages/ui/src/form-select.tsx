/** 标准单选字段共用 shadcn 菜单；标签、校验提示和表单焦点绑定到可见按钮。 */
import type { ComponentProps } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

type Props = ComponentProps<typeof Select> &
  Pick<
    ComponentProps<typeof SelectTrigger>,
    "id" | "ref" | "onBlur" | "aria-invalid" | "aria-describedby"
  > & { placeholder?: string };

export function FormSelect({
  id,
  ref,
  onBlur,
  "aria-invalid": invalid,
  "aria-describedby": description,
  placeholder,
  children,
  ...root
}: Props) {
  return (
    <Select {...root}>
      <SelectTrigger
        className="w-full min-w-0"
        id={id}
        ref={ref}
        onBlur={onBlur}
        aria-invalid={invalid}
        aria-describedby={description}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="w-(--radix-select-trigger-width)">
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  );
}
