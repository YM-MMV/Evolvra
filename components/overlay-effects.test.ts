import { describe, expect, it, vi } from "vitest";
import {
  createOverlayLease,
  restoreOverlayFocus,
} from "@/components/overlay-effects";

function fakeElement(
  initial: Record<string, string> = {},
) {
  const attributes = new Map(Object.entries(initial));
  return {
    attributes,
    isConnected: true,
    style: { overflow: "" },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name: string) {
      return attributes.has(name);
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    closest() {
      return null;
    },
    focus: vi.fn(),
  } as unknown as HTMLElement;
}

function fakeDocument(
  body = fakeElement(),
  main: HTMLElement | null = null,
) {
  return {
    body,
    querySelector: vi.fn(() => main),
  } as unknown as Document;
}

describe("shared overlay effects", () => {
  it("retains isolation and scroll locking until the final owner releases", () => {
    const body = fakeElement();
    body.style.overflow = "auto";
    const targetDocument = fakeDocument(body);
    const background = fakeElement({ "aria-hidden": "false" });
    const modal = createOverlayLease(targetDocument);
    const blocker = createOverlayLease(targetDocument);

    modal.isolate(background, { inert: true });
    modal.lockBodyScroll();
    blocker.isolate(background, { inert: true, ariaHidden: true });
    blocker.lockBodyScroll();

    modal.release();
    expect(background.getAttribute("inert")).toBe("");
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(body.style.overflow).toBe("hidden");

    blocker.release();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.getAttribute("aria-hidden")).toBe("false");
    expect(body.style.overflow).toBe("auto");
  });

  it("reasserts an active blocker after an external attribute or scroll mutation", () => {
    const body = fakeElement();
    const targetDocument = fakeDocument(body);
    const background = fakeElement();
    const blocker = createOverlayLease(targetDocument);
    blocker.isolate(background, { inert: true, ariaHidden: true });
    blocker.lockBodyScroll();

    background.removeAttribute("inert");
    background.setAttribute("aria-hidden", "false");
    body.style.overflow = "visible";
    blocker.reinforce();

    expect(background.getAttribute("inert")).toBe("");
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(body.style.overflow).toBe("hidden");
    blocker.release();
  });

  it("falls back to the main region when the prior focus target was removed", () => {
    const body = fakeElement();
    const main = fakeElement();
    const removed = fakeElement();
    Object.defineProperty(removed, "isConnected", { value: false });
    const targetDocument = fakeDocument(body, main);

    restoreOverlayFocus(targetDocument, removed);

    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(body.focus).not.toHaveBeenCalled();
  });
});
