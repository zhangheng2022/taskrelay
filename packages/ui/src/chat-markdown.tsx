/** 助手正文的 Markdown 展示层：草稿容忍未闭合语法，历史按原文解析；不写回消息。
 * 来源、状态和附件由聊天宿主管理。正文不执行 HTML，也不加载远程图片。 */
import { memo } from "react";
import { Streamdown, defaultRehypePlugins, type Components, type UrlTransform } from "streamdown";
import { harden } from "rehype-harden";
import type { ChatDraft } from "../../contracts/src/streaming";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
} from "./components/ui/code-block";

// 省略 raw 插件，保留清理与加固；外部资源只在用户点击完整网页链接后访问。
const rehypePlugins = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: ["*"],
      allowedProtocols: ["http", "https"],
      allowDataImages: false,
      linkBlockPolicy: "text-only",
      imageBlockPolicy: "text-only",
    },
  ] satisfies [typeof harden, Parameters<typeof harden>[0]],
];
const remend = { linkMode: "text-only" as const, katex: false, htmlTags: false };
const urlTransform: UrlTransform = (url, key) => {
  // oxlint-disable-next-line no-control-regex -- 拒绝会被浏览器隐式剥离的控制字符。
  if (key !== "href" || !/^https?:\/\//i.test(url) || /[\s\\\u0000-\u001f\u007f]/.test(url))
    return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname && !parsed.username && !parsed.password ? url : "";
  } catch {
    return "";
  }
};
const components: Components = {
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-4 break-words"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-muted-foreground">{alt || "图片"}</span>,
  pre: ({ node }) => {
    const code = node?.children.find(
      (child) => child.type === "element" && child.tagName === "code",
    );
    if (!code || code.type !== "element") return null;
    const value = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
    const language = Array.isArray(code.properties.className)
      ? String(
          code.properties.className.find((name) => String(name).startsWith("language-")) ?? "",
        ).slice(9)
      : "";
    return (
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>{language || "代码"}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton
              value={value}
              copyLabel="复制代码"
              copiedLabel="已复制"
              errorLabel="复制失败，请重试"
            />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent lineNumbers>{value}</CodeBlockContent>
      </CodeBlock>
    );
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  status,
}: {
  content: string;
  status?: ChatDraft["status"];
}) {
  return (
    <Streamdown
      mode={status ? "streaming" : "static"}
      parseIncompleteMarkdown={!!status}
      isAnimating={status === "streaming"}
      remend={remend}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
      controls={false}
      className="chat-markdown min-w-0 max-w-full text-sm leading-7"
    >
      {content}
    </Streamdown>
  );
});
