/** 复用 shadcn 展开按钮；高级表单折叠后仍需提交其中的值并保留草稿。 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "./components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";

export function Disclosure({
  label,
  children,
  keepMounted,
  className,
}: {
  label: string;
  children: ReactNode;
  keepMounted?: boolean;
  className?: string;
}) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group">
          <ChevronRight aria-hidden="true" className="group-aria-expanded:rotate-90" />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount={keepMounted || undefined}
        className="data-[state=closed]:hidden"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
