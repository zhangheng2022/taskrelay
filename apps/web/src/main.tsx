import "../../../packages/ui/src/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "../../../packages/ui/src/auth-gate";
import { App } from "../../../packages/ui/src/app";
import { createWebTransport } from "./transport";
const transport = createWebTransport();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate transport={transport}>
      <App transport={transport} />
    </AuthGate>
  </React.StrictMode>,
);
