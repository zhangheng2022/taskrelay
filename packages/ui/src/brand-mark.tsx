import { cn } from "./lib/utils";

// Decorative mark: the adjacent TaskRelay name or page title supplies the label.
// CSS uses the same SVG master as the generated Windows and browser icons.
export function BrandMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("brand-mark inline-block w-8 shrink-0", className)} />
  );
}
