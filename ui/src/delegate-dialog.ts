/**
 * First-run consent for the local Freenet delegate.
 *
 * A delegate is installed per node, and the board cannot ask for an owner key
 * until one answers. This dialog therefore blocks the board the same way the
 * identity setup does: `requestInstall` resolves only after `installDelegate()`
 * succeeds, and rejects with a plain sentence when the user chooses "Not now".
 * Escape and the backdrop cannot dismiss it into an ambiguous state, so the
 * only outcomes are a completed install or an explicit refusal.
 */
import { DelegateError } from "./delegate";
import { errorMessage } from "./util";

export interface DelegateDialogDeps {
  offline: boolean;
  installDelegate(): Promise<void>;
  announce(message: string): void;
}

export interface DelegateDialog {
  /** Resolve after a successful install; reject on an explicit refusal. */
  requestInstall(): Promise<void>;
}

export const DELEGATE_DECLINED_MESSAGE =
  "number needs its local component before it can use this node.";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const NOOP_DIALOG: DelegateDialog = {
  requestInstall: () => Promise.resolve(),
};

export function createDelegateDialog(
  deps: DelegateDialogDeps,
): DelegateDialog {
  // Offline mode has no node and no delegate. Returning before touching the
  // DOM also guarantees the offline e2e tier cannot open this dialog.
  if (deps.offline) return NOOP_DIALOG;

  const dialog = byId<HTMLDialogElement>("delegate-install");
  const shell = byId<HTMLDivElement>("delegate-shell");
  const title = byId<HTMLHeadingElement>("delegate-title");
  const installButton = byId<HTMLButtonElement>("delegate-install-button");
  const notNowButton = byId<HTMLButtonElement>("delegate-not-now");
  const progress = byId<HTMLParagraphElement>("delegate-progress");
  const errorBox = byId<HTMLParagraphElement>("delegate-error");

  let pending: Promise<void> | null = null;
  let resolvePending: (() => void) | null = null;
  let rejectPending: ((reason: Error) => void) | null = null;
  let installing = false;

  function setBusy(value: boolean): void {
    installing = value;
    installButton.disabled = value;
    notNowButton.disabled = value;
    installButton.textContent = value ? "Installing…" : "Install number";
    installButton.setAttribute("aria-busy", String(value));
    shell.setAttribute("aria-busy", String(value));
    progress.hidden = !value;
  }

  function clearError(): void {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function open(): void {
    clearError();
    setBusy(false);
    if (!dialog.open) {
      dialog.showModal();
      title.focus({ preventScroll: true });
    }
  }

  /** Drop the deferred without settling it (the caller settles it). */
  function takePending(): {
    resolve: (() => void) | null;
    reject: ((reason: Error) => void) | null;
  } {
    const settle = { resolve: resolvePending, reject: rejectPending };
    pending = null;
    resolvePending = null;
    rejectPending = null;
    return settle;
  }

  function requestInstall(): Promise<void> {
    if (!pending) {
      pending = new Promise<void>((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
      open();
    }
    return pending;
  }

  async function install(): Promise<void> {
    if (installing || !pending) return;

    clearError();
    setBusy(true);

    try {
      await deps.installDelegate();
    } catch (error) {
      if (!pending) return;
      setBusy(false);
      errorBox.textContent = `Could not install the local component. ${errorMessage(error)}`;
      errorBox.hidden = false;
      installButton.focus({ preventScroll: true });
      return;
    }

    if (!pending) return;
    const { resolve } = takePending();
    setBusy(false);
    if (dialog.open) dialog.close();
    resolve?.();
    deps.announce("The local component is installed.");
  }

  function decline(): void {
    if (installing || !pending) return;
    const { reject } = takePending();
    setBusy(false);
    if (dialog.open) dialog.close();
    reject?.(new DelegateError("Missing", DELEGATE_DECLINED_MESSAGE));
  }

  installButton.addEventListener("click", () => {
    void install();
  });
  notNowButton.addEventListener("click", decline);

  // Match the identity setup: Escape must not stop the board with an implicit
  // refusal. "Not now" is the explicit way out, and it surfaces an error notice.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });

  // Defensive: if something else closes the dialog while the board is waiting,
  // reopen instead of leaving the board blocked with no visible explanation.
  dialog.addEventListener("close", () => {
    if (!pending) return;
    try {
      dialog.showModal();
      title.focus({ preventScroll: true });
    } catch {
      // The board still waits; a reload returns to this prompt.
    }
  });

  return { requestInstall };
}
