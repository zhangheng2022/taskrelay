import { ShieldQuestion } from "lucide-react";
import type { HumanChallenge } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemMedia,
  ItemFooter,
} from "./components/ui/item";
import { formatDate } from "./feedback";

export function ChallengePanel({
  challenge,
  image,
  expired,
  submitted,
  cancelled,
  disabled,
  onReply,
  onDeny,
}: {
  challenge: HumanChallenge;
  image?: string;
  expired: boolean;
  submitted: boolean;
  cancelled: boolean;
  disabled: boolean;
  onReply: (text: string) => void;
  onDeny: () => void;
}) {
  const pending =
    challenge.status === "pending" && !submitted && !expired && !cancelled;
  return (
    <Item variant="outline" size="sm" aria-label="当前协助请求">
      <ItemMedia variant="icon">
        <ShieldQuestion />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          {challenge.kind === "approval"
            ? "确认这次操作"
            : challenge.kind === "unsupported"
              ? "当前验证不支持"
              : "需要你的协助"}
        </ItemTitle>
        <ItemDescription>
          {formatDate(challenge.expiresAt)} 前有效
        </ItemDescription>
        <p className="whitespace-pre-wrap break-words text-sm leading-7">
          {challenge.instruction}
        </p>
        {image && pending && (
          <img
            src={image}
            className="max-h-64 max-w-full self-start"
            alt="当前步骤的验证图片"
          />
        )}
      </ItemContent>
      {pending && ["approval", "scan"].includes(challenge.kind) && (
        <ItemActions className="w-full flex-wrap">
          <Button
            size="sm"
            disabled={disabled}
            onClick={() =>
              onReply(
                challenge.kind === "approval"
                  ? "确认执行"
                  : "已扫码并完成外部确认，请检查网站状态",
              )
            }
          >
            {challenge.kind === "approval" ? "确认执行" : "已扫码，检查状态"}
          </Button>
          {challenge.kind === "approval" && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onDeny}
            >
              拒绝并取消本次运行
            </Button>
          )}
        </ItemActions>
      )}
      <ItemFooter>
        <p role="status" className="text-xs text-muted-foreground">
          {cancelled
            ? "已请求取消，不再接受此步骤的回复。"
            : expired
              ? "此协助请求已过期，请等待执行状态更新。"
              : !pending
                ? "已回复，等待执行器核查网站实际状态。"
                : challenge.kind === "unsupported"
                  ? "当前通道无法完成此验证，可取消本次运行。"
                  : "回复只用于当前步骤，不进入聊天记录。"}
        </p>
      </ItemFooter>
    </Item>
  );
}
