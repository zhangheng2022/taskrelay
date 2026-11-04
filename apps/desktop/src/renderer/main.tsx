import "../../../../packages/ui/src/styles.css";
import { createRoot } from "react-dom/client";
import { ExecutorApp } from "../../../../packages/ui/src/executor-app";
import type { Transport } from "../../../../packages/contracts/src/index";
declare global {
  interface Window {
    taskrelay: NonNullable<Transport['desktop']>;
  }
}
createRoot(document.getElementById("root")!).render(
  <ExecutorApp executor={window.taskrelay} />,
);
