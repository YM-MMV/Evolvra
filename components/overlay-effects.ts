"use client";

export interface OverlayIsolationOptions {
  readonly inert?: boolean;
  readonly ariaHidden?: boolean;
}

interface ElementIsolationRecord {
  readonly baselineInert: string | null;
  readonly baselineAriaHidden: string | null;
  readonly inertOwners: Set<symbol>;
  readonly ariaHiddenOwners: Set<symbol>;
}

interface BodyScrollRecord {
  readonly baselineOverflow: string;
  readonly owners: Set<symbol>;
}

const elementIsolationRecords = new Map<HTMLElement, ElementIsolationRecord>();
const bodyScrollRecords = new WeakMap<Document, BodyScrollRecord>();

function restoreAttribute(
  element: HTMLElement,
  name: "inert" | "aria-hidden",
  value: string | null,
) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function reconcileElementIsolation(
  element: HTMLElement,
  record: ElementIsolationRecord,
) {
  if (record.inertOwners.size) {
    if (!element.hasAttribute("inert")) element.setAttribute("inert", "");
  } else {
    restoreAttribute(element, "inert", record.baselineInert);
  }

  if (record.ariaHiddenOwners.size) {
    if (element.getAttribute("aria-hidden") !== "true") {
      element.setAttribute("aria-hidden", "true");
    }
  } else {
    restoreAttribute(element, "aria-hidden", record.baselineAriaHidden);
  }
}

function releaseElementOwner(
  owner: symbol,
  element: HTMLElement,
  options: OverlayIsolationOptions,
) {
  const record = elementIsolationRecords.get(element);
  if (!record) return;
  if (options.inert) record.inertOwners.delete(owner);
  if (options.ariaHidden) record.ariaHiddenOwners.delete(owner);
  reconcileElementIsolation(element, record);
  if (!record.inertOwners.size && !record.ariaHiddenOwners.size) {
    elementIsolationRecords.delete(element);
  }
}

/**
 * Coordinates the document-wide side effects shared by modal surfaces.
 * Every lease is idempotent and restores the exact pre-overlay attributes only
 * after the final owner releases them.
 */
export function createOverlayLease(targetDocument: Document) {
  const owner = Symbol("overlay-owner");
  const elements = new Map<HTMLElement, OverlayIsolationOptions>();
  let scrollLocked = false;
  let released = false;

  const isolate = (
    element: HTMLElement,
    options: OverlayIsolationOptions = { inert: true },
  ) => {
    if (released) return;
    const previous = elements.get(element);
    const combined = {
      inert: Boolean(previous?.inert || options.inert),
      ariaHidden: Boolean(previous?.ariaHidden || options.ariaHidden),
    };
    elements.set(element, combined);

    let record = elementIsolationRecords.get(element);
    if (!record) {
      record = {
        baselineInert: element.getAttribute("inert"),
        baselineAriaHidden: element.getAttribute("aria-hidden"),
        inertOwners: new Set(),
        ariaHiddenOwners: new Set(),
      };
      elementIsolationRecords.set(element, record);
    }
    if (combined.inert) record.inertOwners.add(owner);
    if (combined.ariaHidden) record.ariaHiddenOwners.add(owner);
    reconcileElementIsolation(element, record);
  };

  const lockBodyScroll = () => {
    if (released || scrollLocked) return;
    scrollLocked = true;
    let record = bodyScrollRecords.get(targetDocument);
    if (!record) {
      record = {
        baselineOverflow: targetDocument.body.style.overflow,
        owners: new Set(),
      };
      bodyScrollRecords.set(targetDocument, record);
    }
    record.owners.add(owner);
    targetDocument.body.style.overflow = "hidden";
  };

  const reinforce = () => {
    if (released) return;
    for (const [element] of elements) {
      const record = elementIsolationRecords.get(element);
      if (record) reconcileElementIsolation(element, record);
    }
    if (
      scrollLocked
      && targetDocument.body.style.overflow !== "hidden"
    ) {
      targetDocument.body.style.overflow = "hidden";
    }
  };

  const release = () => {
    if (released) return;
    released = true;
    for (const [element, options] of elements) {
      releaseElementOwner(owner, element, options);
    }
    elements.clear();

    if (scrollLocked) {
      const record = bodyScrollRecords.get(targetDocument);
      record?.owners.delete(owner);
      if (record && !record.owners.size) {
        targetDocument.body.style.overflow = record.baselineOverflow;
        bodyScrollRecords.delete(targetDocument);
      } else if (record) {
        targetDocument.body.style.overflow = "hidden";
      }
      scrollLocked = false;
    }
  };

  return {
    isolate,
    lockBodyScroll,
    reinforce,
    release,
  };
}

export function canRestoreOverlayFocus(
  element: HTMLElement | null,
): element is HTMLElement {
  return Boolean(
    element?.isConnected
    && !element.closest("[inert]")
    && !element.closest("[aria-hidden='true']"),
  );
}

export function restoreOverlayFocus(
  targetDocument: Document,
  preferred: HTMLElement | null,
) {
  const target = canRestoreOverlayFocus(preferred)
    ? preferred
    : targetDocument.querySelector<HTMLElement>("#main-content");
  if (canRestoreOverlayFocus(target)) {
    target.focus({ preventScroll: true });
    return;
  }
  targetDocument.body.focus({ preventScroll: true });
}
