import { createRoot } from "react-dom/client";
import { App } from "../../../../packages/ui/src/app";
import type { Transport } from "../../../../packages/contracts/src/index";
declare global {
  interface Window {
    taskrelay: Transport;
  }
}
createRoot(document.getElementById("root")!).render(
  <App transport={window.taskrelay} />,
);
