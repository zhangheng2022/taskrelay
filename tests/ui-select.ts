import { fireEvent, within } from "@testing-library/react";

export async function chooseOption(trigger: HTMLElement, label: string) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await within(document.body).findByRole("listbox");
  fireEvent.keyDown(within(menu).getByRole("option", { name: label }), {
    key: "Enter",
  });
}
