import "../../../packages/ui/src/styles.css";
// Dedicated development-only UI fixture; not imported by the production entry.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../packages/ui/src/app";
import { ExecutorApp } from "../../../packages/ui/src/executor-app";
import { AuthGate } from "../../../packages/ui/src/auth-gate";
import { createFixtureTransport } from "./ui-fixture-transport";
const options = new URLSearchParams(location.search);
const transport = createFixtureTransport(options);
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {options.has("auth") ? (
        <AuthGate
          transport={{
            request: async () => {
              throw new Error("AUTH_REQUIRED");
            },
          }}
        >
          <span>演示工作空间</span>
        </AuthGate>
      ) : options.has("executor") ? (
        <ExecutorApp executor={transport.desktop!} />
      ) : (
        <App transport={transport} />
      )}
    </React.StrictMode>,
  );
