import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../packages/ui/src/app";
import type { Transport } from "../../../packages/contracts/src/index";
const transport: Transport = {
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new Error("OFFLINE");
    }
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("ACCESS_REQUIRED");
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP_${response.status}`);
    return data;
  },
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App transport={transport} />
  </React.StrictMode>,
);
