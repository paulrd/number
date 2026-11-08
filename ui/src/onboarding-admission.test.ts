/**
 * Candidate-side admission codes end to end through the onboarding panel.
 *
 * There is no DOM emulator in this project, so the harness below is the small
 * subset of the DOM the panel touches. Verification is injected, so these tests
 * exercise the view and the freshness rule rather than Ed25519 (covered by
 * `admission.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMISSION_CODE_PREFIX,
  encodeAdmissionCode,
  type AdmissionCode,
  type AdmissionResult,
} from "./admission";
import type { BoardSnapshot } from "./board";
import type { CandidateTransport } from "./candidate-client";
import {
  createOnboardingPanel,
  type OnboardingPanel,
  type OnboardingPanelDeps,
} from "./onboarding-panel";
import { emptyState, type Entry, type Slot, type StateV3 } from "./state";

const OWNER = "a".repeat(64);
const SELF = "b".repeat(64);
const OTHER = "c".repeat(64);
const ROOT = "d".repeat(64);
const SLOT = 5;

class FakeElement {
  id: string;
  hidden = false;
  textContent = "";
  title = "";
  value = "";
  disabled = false;
  open = false;
  className = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private classes = new Set<string>();

  constructor(id = "") {
    this.id = id;
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    if (this.disabled) return;
    this.dispatch("click", { preventDefault() {}, target: this });
  }

  focus(): void {
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement =
      this;
  }

  select(): void {}

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes;
    this.textContent = "";
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  reset(): void {}

  requestSubmit(): void {
    this.dispatch("submit", { preventDefault() {} });
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.dispatch("close", {});
  }
}

const ELEMENT_IDS = [
  "join-dialog",
  "join-title",
  "join-close",
  "join-root-step",
  "join-root-title",
  "join-root-form",
  "join-root-input",
  "join-root-continue",
  "join-root-error",
  "join-root-status",
  "join-discovery",
  "join-place-title",
  "join-place-form",
  "join-lat",
  "join-lng",
  "join-point",
  "join-place-status",
  "join-place-check",
  "join-place-error",
  "join-map",
  "join-map-fallback",
  "join-loading",
  "join-result",
  "join-result-title",
  "join-result-lede",
  "join-chain",
  "join-target-area",
  "join-target-id",
  "join-target-address",
  "join-target-slots",
  "join-target-accepting",
  "join-assigned-badge",
  "join-assigned-slot",
  "join-assigned-digit",
  "join-assigned-address",
  "join-assigned-warning",
  "join-request-form",
  "join-note",
  "join-note-count",
  "join-public-id",
  "join-public-cell",
  "join-public-note",
  "join-submit",
  "join-request-error",
  "join-request-blocked",
  "join-request-success",
  "join-request-id",
  "join-saturated-area",
  "join-saturated-title",
  "join-saturated-reason",
  "join-try-another",
  "join-status-step",
  "join-status-title",
  "join-status-lede",
  "join-status-loading",
  "join-status-error",
  "join-status-queued",
  "join-status-self",
  "join-status-cell",
  "join-status-note",
  "join-status-invited",
  "join-interview-target",
  "join-interview-count",
  "join-interview-warning",
  "join-interview-loading",
  "join-interview-empty",
  "join-interview-messages",
  "join-interview-composer",
  "join-interview-input",
  "join-interview-hint",
  "join-interview-send",
  "join-interview-error",
  "join-status-admitted",
  "join-admitted-badge",
  "join-admitted-slot",
  "join-admitted-digit",
  "join-admitted-address",
  "join-admitted-source",
  "join-admitted-owner",
  "join-admitted-blocked",
  "join-admitted-error",
  "join-admitted-sign",
  "join-admitted-done",
  "join-admitted-done-text",
  "join-status-actions",
  "join-status-check",
];

interface Harness {
  panel: OnboardingPanel;
  elements: Map<string, FakeElement>;
  readBoard: ReturnType<typeof vi.fn>;
  transportRead: ReturnType<typeof vi.fn>;
  saveParent: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  zones: Map<string, StateV3 | null>;
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    value: 0n,
    contact: SELF,
    unit: null,
    note: null,
    ...overrides,
  };
}

function code(overrides: Partial<AdmissionCode> = {}): AdmissionCode {
  return {
    owner: OWNER,
    candidate: SELF,
    slot: SLOT,
    seq: 3,
    entry: entry(),
    address: "00",
    sig: "0".repeat(128),
    ...overrides,
  };
}

function slot(overrides: Partial<Slot> = {}): Slot {
  return { seq: 3, entry: entry(), sig: "0".repeat(128), ...overrides };
}

function snapshot(ownerId: string, state: StateV3): BoardSnapshot {
  return { ownerId, state, contacts: [], codeHash: "", legacy: false };
}

function stateWithSlot(record: Slot): StateV3 {
  const zone = emptyState();
  zone.slots[SLOT] = record;
  return zone;
}

function installDom(search = ""): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  for (const id of ELEMENT_IDS) elements.set(id, new FakeElement(id));

  const location = {
    search,
    href: `https://example.test/app${search}`,
  };
  const history = {
    state: null as unknown,
    replaceState(_state: unknown, _title: string, url: string): void {
      const next = new URL(url, location.href);
      location.search = next.search;
      location.href = next.toString();
    },
  };
  const windowStub = {
    location,
    history,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: (time: number) => void) => {
      callback(0);
      return 0;
    },
  };

  const documentStub = {
    activeElement: null as unknown,
    body: new FakeElement("body"),
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
  };

  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("HTMLElement", FakeElement);
  return elements;
}

function harness(options: {
  ownerState?: StateV3 | null;
  selfState?: StateV3 | null;
  verify?: (
    text: string,
    options: { candidate: string | null; expectedOwner?: string | null },
  ) => Promise<AdmissionResult>;
  search?: string;
} = {}): Harness {
  const elements = installDom(options.search ?? "");
  const zones = new Map<string, StateV3 | null>();
  zones.set(OWNER, options.ownerState ?? stateWithSlot(slot()));
  zones.set(SELF, options.selfState ?? emptyState());
  zones.set(ROOT, emptyState());

  const readBoard = vi.fn(async (ownerId: string) => {
    const state = zones.get(ownerId);
    return state === undefined || state === null
      ? null
      : snapshot(ownerId, state);
  });
  const transportRead = vi.fn(async () => null);
  const transport = {
    read: transportRead,
  } as unknown as CandidateTransport;
  const saveParent = vi.fn(async () => {});
  const verify = vi.fn(
    options.verify ??
      (async (): Promise<AdmissionResult> => ({ ok: true, code: code() })),
  );

  const deps: OnboardingPanelDeps = {
    readBoard,
    transport,
    selfId: () => SELF,
    watchBoard: () => () => {},
    saveParent,
    announce: () => {},
    onSettled: () => {},
    verifyAdmission: verify,
  };

  return {
    panel: createOnboardingPanel(deps),
    elements,
    readBoard,
    transportRead,
    saveParent,
    verify,
    zones,
  };
}

function element(harness: Harness, id: string): FakeElement {
  const found = harness.elements.get(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}

async function submitCode(
  harness: Harness,
  text: string,
  wait: () => void,
): Promise<void> {
  element(harness, "join-root-input").value = text;
  element(harness, "join-root-form").requestSubmit();
  await vi.waitFor(wait);
}

describe("candidate-side admission code", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lands on the admitted view and signs with the code's owner", async () => {
    const h = harness();
    h.panel.open("");
    element(h, "join-root-input").value = encodeAdmissionCode(code());
    element(h, "join-root-form").requestSubmit();

    await vi.waitFor(() =>
      expect(element(h, "join-admitted-slot").textContent).toBe("Slot 6"),
    );

    expect(element(h, "join-root-step").hidden).toBe(true);
    expect(element(h, "join-admitted-slot").textContent).toBe("Slot 6");
    expect(element(h, "join-admitted-digit").textContent).toBe(
      "zero-based digit 5, cell f",
    );
    expect(element(h, "join-admitted-address").textContent).toBe("005");
    expect(element(h, "join-admitted-owner").textContent).toBe(OWNER);
    expect(element(h, "join-admitted-owner").title).toBe(OWNER);
    expect(element(h, "join-admitted-source").hidden).toBe(false);
    expect(element(h, "join-admitted-source").textContent).toContain(
      "Admission code",
    );
    expect(element(h, "join-admitted-blocked").hidden).toBe(true);
    expect(element(h, "join-admitted-sign").disabled).toBe(false);
    expect(element(h, "join-admitted-sign").hidden).toBe(false);
    expect(element(h, "join-status-actions").hidden).toBe(false);
    expect(element(h, "join-status-check").hidden).toBe(false);
    expect(element(h, "join-status-check").disabled).toBe(false);

    element(h, "join-admitted-sign").click();
    await vi.waitFor(() => expect(h.saveParent).toHaveBeenCalledWith(OWNER));
    await vi.waitFor(() =>
      expect(element(h, "join-admitted-done-text").textContent).toContain(
        "is now your zone's parent",
      ),
    );
  });

  it("passes the open flow's root as expectedOwner", async () => {
    const h = harness({
      verify: async (_text, options) =>
        options.expectedOwner === ROOT
          ? { ok: false, reason: "owner" }
          : { ok: true, code: code() },
    });
    h.panel.open(ROOT);
    await vi.waitFor(() =>
      expect(element(h, "join-root-step").hidden).toBe(true),
    );

    element(h, "join-root-input").value = encodeAdmissionCode(code());
    element(h, "join-root-form").requestSubmit();
    await vi.waitFor(() => expect(h.verify).toHaveBeenCalledTimes(1));

    expect(h.verify.mock.calls[0]![1]).toMatchObject({
      candidate: SELF,
      expectedOwner: ROOT,
    });
    await vi.waitFor(() =>
      expect(element(h, "join-root-error").textContent).toContain(
        "different zone",
      ),
    );
    expect(element(h, "join-root-error").hidden).toBe(false);
  });

  it("proceeds silently when the owner copy is stale", async () => {
    const h = harness({
      ownerState: stateWithSlot(slot({ seq: 2, entry: entry({ contact: OTHER }) })),
    });
    h.panel.open(encodeAdmissionCode(code()));

    await vi.waitFor(() =>
      expect(element(h, "join-admitted-slot").textContent).toBe("Slot 6"),
    );
    expect(element(h, "join-admitted-blocked").hidden).toBe(true);
    expect(element(h, "join-admitted-sign").disabled).toBe(false);
  });

  it("blocks when the owner copy shows a newer, different admission", async () => {
    const h = harness({
      ownerState: stateWithSlot(slot({ seq: 4, entry: entry({ contact: OTHER }) })),
    });
    h.panel.open(encodeAdmissionCode(code()));

    await vi.waitFor(() =>
      expect(element(h, "join-admitted-blocked").textContent).toContain(
        "different admission",
      ),
    );
    expect(element(h, "join-admitted-blocked").hidden).toBe(false);
    expect(element(h, "join-admitted-blocked").textContent).toBe(
      "This zone now shows a different admission. Ask the owner for a new code, then check again.",
    );
    expect(element(h, "join-admitted-sign").disabled).toBe(true);
  });

  it("shows a readable candidate mismatch and stays on the root step", async () => {
    const h = harness({
      verify: async () => ({ ok: false, reason: "candidate" }),
    });
    h.panel.open("");

    await submitCode(h, `${ADMISSION_CODE_PREFIX}abc`, () =>
      expect(element(h, "join-root-error").textContent).toContain(
        "different identity",
      ),
    );

    expect(element(h, "join-root-step").hidden).toBe(false);
    expect(element(h, "join-status-step").hidden).toBe(true);
    expect(element(h, "join-root-error").hidden).toBe(false);
    expect(element(h, "join-root-error").textContent).toContain(
      "different identity",
    );
  });

  it("re-reads the owner zone on Check again instead of walking the tree", async () => {
    const h = harness();
    h.panel.open(encodeAdmissionCode(code()));
    await vi.waitFor(() =>
      expect(element(h, "join-admitted-slot").textContent).toBe("Slot 6"),
    );
    expect(h.readBoard).toHaveBeenCalledWith(OWNER);

    const ownerReads = h.readBoard.mock.calls.filter(
      ([owner]) => owner === OWNER,
    ).length;
    h.zones.set(
      OWNER,
      stateWithSlot(slot({ seq: 4, entry: entry({ contact: OTHER }) })),
    );

    await vi.waitFor(() =>
      expect(element(h, "join-status-check").hidden).toBe(false),
    );
    element(h, "join-status-check").click();

    await vi.waitFor(() =>
      expect(element(h, "join-admitted-blocked").textContent).toContain(
        "different admission",
      ),
    );
    const laterOwnerReads = h.readBoard.mock.calls.filter(
      ([owner]) => owner === OWNER,
    ).length;
    expect(laterOwnerReads).toBeGreaterThan(ownerReads);
    expect(h.transportRead).not.toHaveBeenCalled();
    expect(element(h, "join-status-step").hidden).toBe(false);
    expect(element(h, "join-admitted-blocked").textContent).toContain(
      "different admission",
    );
  });

  it("renders with an unreadable owner zone and a null target zone", async () => {
    const h = harness({ ownerState: null });
    h.panel.open(encodeAdmissionCode(code()));

    await vi.waitFor(() =>
      expect(element(h, "join-admitted-slot").textContent).toBe("Slot 6"),
    );
    expect(element(h, "join-admitted-address").textContent).toBe("005");
    expect(element(h, "join-admitted-source").hidden).toBe(false);
    expect(element(h, "join-admitted-blocked").hidden).toBe(true);
    expect(element(h, "join-admitted-sign").disabled).toBe(false);
  });
});
