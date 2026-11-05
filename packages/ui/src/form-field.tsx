import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Field as ShadcnField, FieldLabel, FieldDescription } from "./components/ui/field";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const child = isValidElement(children)
    ? (children as ReactElement<{ id?: string; "aria-describedby"?: string }>)
    : null;
  const id = child?.props.id ?? generated;
  return (
    <ShadcnField>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {child
        ? cloneElement(child, {
            id,
            ...(hint ? { "aria-describedby": id + "-hint" } : {}),
          })
        : children}
      {hint && <FieldDescription id={id + "-hint"}>{hint}</FieldDescription>}
    </ShadcnField>
  );
}
