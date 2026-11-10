/** 结构化正文的词法预览：只读取顶层指定字段，处理跨块转义；不执行半成品 JSON。
 * 问题必须先读到完整 askUser=true；重复字段或无效词法拒绝预览。 */
export function previewText(input: string, mode: "text" | "reply" | "question"): string {
  if (mode === "text") return input;
  const fields = new Map<string, string | boolean>();
  let i = 0;
  const whitespace = () => {
    while (i < input.length && " \n\r\t".includes(input[i])) i++;
  };
  const string = (): { value: string; complete: boolean } => {
    i++;
    let value = "";
    while (i < input.length) {
      const c = input[i++];
      if (c === '"') return { value, complete: true };
      if (c.charCodeAt(0) < 32) throw Error();
      if (c !== "\\") {
        value += c;
        continue;
      }
      if (i === input.length) break;
      const e = input[i++];
      if (e === "u") {
        if (i + 4 > input.length) break;
        const hex = input.slice(i, i + 4);
        if (!hex.split("").every((x) => "0123456789abcdefABCDEF".includes(x))) throw Error();
        value += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else {
        const escapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!(e in escapes)) throw Error();
        value += escapes[e];
      }
    }
    // 不把跨块代理对的前半字符发给 UI。
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1);
    return { value, complete: false };
  };
  try {
    whitespace();
    if (input[i++] !== "{") return "";
    for (;;) {
      whitespace();
      if (i >= input.length || input[i] === "}") break;
      if (input[i] !== '"') return "";
      const key = string();
      if (!key.complete) break;
      if (fields.has(key.value)) return "";
      whitespace();
      if (input[i++] !== ":") break;
      whitespace();
      if (input[i] === '"') {
        const value = string();
        fields.set(key.value, value.value);
        if (!value.complete) break;
      } else {
        const start = i;
        let depth = 0;
        while (i < input.length) {
          const c = input[i];
          if (c === '"') {
            if (!string().complete) break;
            continue;
          }
          if (depth === 0 && (c === "," || c === "}")) break;
          if (c === "{" || c === "[") depth++;
          if (c === "}" || c === "]") depth--;
          i++;
        }
        if (i === input.length) break;
        const value: unknown = JSON.parse(input.slice(start, i));
        fields.set(key.value, typeof value === "boolean" ? value : "");
      }
      whitespace();
      if (input[i] === "}") break;
      if (i === input.length) break;
      if (input[i++] !== ",") return "";
    }
    if (mode === "question" && fields.get("askUser") !== true) return "";
    const value = fields.get(mode === "reply" ? "reply" : "message");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
