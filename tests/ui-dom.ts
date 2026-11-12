import { JSDOM } from "jsdom";

// Layout/scroll are checked in the browser; DOM tests exercise production components and Transport calls.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "DocumentFragment",
  "HTMLInputElement",
  "HTMLFormElement",
  "NodeFilter",
  "Element",
  "Node",
  "MutationObserver",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "getComputedStyle",
  "localStorage",
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  ResizeObserver: Observer,
  IntersectionObserver: Observer,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(dom.window, {
  ResizeObserver: Observer,
  IntersectionObserver: Observer,
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});
dom.window.HTMLElement.prototype.scrollTo = function () {};
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

export { dom };
