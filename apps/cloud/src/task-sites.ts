import { publicUrl } from "../../../packages/contracts/src/security";

// Extract address hints from user text. AI may also infer a public entry URL;
// these hints are not an authorization list. Public URL and DNS checks remain.
export function suppliedTaskUrls(content: string): string[] {
  const urls = new Set<string>();
  const candidates = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`，。；、！？（）)\]}]+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}(?::\d+)?(?:[/?#][^\s<>"'`，。；、！？（）)\]}]*)?/gi;
  for (const match of content.matchAll(candidates)) {
    const before = content[match.index - 1] ?? "";
    const after = content[match.index + match[0].length] ?? "";
    const sentenceEnd = after === "." && /^(?:$|[\s，。；、！？）)\]}>])/.test(content.slice(match.index + match[0].length + 1));
    // Do not extract a domain from an email, credential, unsupported scheme,
    // relative path or malformed host by accepting just a matching substring.
    if (/[a-z0-9_@./:\\%-]/i.test(before) || (!sentenceEnd && /[a-z0-9_@.:\\%-]/i.test(after))) continue;
    const candidate = match[0].replace(/[.,;!]+$/, "");
    const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
    try {
      const url = publicUrl(explicit ? candidate : `https://${candidate}`);
      if (!explicit && !url.hostname.split(".").every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) continue;
      urls.add(url.href);
    } catch {
      // Invalid/private addresses are not usable navigation hints.
    }
  }
  return [...urls];
}
