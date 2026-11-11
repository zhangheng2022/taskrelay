import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import {
  Field as ShadcnField,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "./components/ui/field";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const child = isValidElement(children)
    ? (children as ReactElement<{ id?: string; "aria-describedby"?: string }>)
    : null;
  const id = child?.props.id ?? generated;
  const describedBy =
    [child?.props["aria-describedby"], hint && id + "-hint", error && id + "-error"]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <ShadcnField data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {child
        ? cloneElement(child, {
            id,
            "aria-describedby": describedBy,
            ...(error ? { "aria-invalid": true } : {}),
          })
        : children}
      {hint && <FieldDescription id={id + "-hint"}>{hint}</FieldDescription>}
      {error && <FieldError id={id + "-error"}>{error}</FieldError>}
    </ShadcnField>
  );
}
