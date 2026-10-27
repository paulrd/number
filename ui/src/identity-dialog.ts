/**
 * Owner identity setup and backup dialogs.
 *
 * The first-run dialog is a blocker for the board: `requestIdentity` resolves
 * only after the user explicitly creates an identity or successfully imports
 * a backup. Escape, the backdrop, and any stray `close()` call cannot dismiss
 * it into an implicit new key, because the delegate refuses imports once a
 * seed exists.
 *
 * The backup dialog only ever puts the seed in a readonly textarea after the
 * user asks to reveal it, and clears it again on hide or close.
 */
import type { DelegateIdentity, ExportedSecrets } from "./delegate";
import {
  decodeIdentityBackup,
  encodeIdentityBackup,
  identityBackupFilename,
  type DecodedIdentityBackup,
} from "./identity";
import { errorMessage } from "./util";

export interface IdentityDialogDeps {
  offline: boolean;
  getIdentity(): DelegateIdentity | null;
  exportIdentity(): Promise<ExportedSecrets>;
  importIdentity(
    seed: string,
    nextSeq: number[],
    contactsNextSeq: number,
  ): Promise<void>;
  announce(message: string): void;
  copy(
    text: string,
    label: string,
    button: HTMLButtonElement,
  ): Promise<boolean>;
  onRestored(): void;
  onCreate(): void;
}

export interface IdentityDialogs {
  /** Resolve only after an explicit create or a successful restore. */
  requestIdentity(): Promise<void>;
  openManagement(): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const NOOP_DIALOGS: IdentityDialogs = {
  requestIdentity: () => Promise.resolve(),
  openManagement: () => {},
};

export function createIdentityDialogs(
  deps: IdentityDialogDeps,
): IdentityDialogs {
  // Offline mode has no delegate and no identity management. Returning before
  // touching the DOM also guarantees the e2e offline tier cannot open a dialog.
  if (deps.offline) return NOOP_DIALOGS;

  const setupDialog = byId<HTMLDialogElement>("identity-setup");
  const setupTitle = byId<HTMLHeadingElement>("identity-setup-title");
  const choiceStage = byId<HTMLDivElement>("identity-setup-choice");
  const createButton = byId<HTMLButtonElement>("identity-create");
  const showRestoreButton = byId<HTMLButtonElement>("identity-show-restore");
  const restoreForm = byId<HTMLFormElement>("identity-restore-form");
  const restoreInput = byId<HTMLTextAreaElement>("identity-restore-input");
  const restoreError = byId<HTMLParagraphElement>("identity-restore-error");
  const restoreBack = byId<HTMLButtonElement>("identity-restore-back");
  const restoreSubmit = byId<HTMLButtonElement>("identity-restore-submit");

  const manageDialog = byId<HTMLDialogElement>("identity-manage");
  const manageTitle = byId<HTMLHeadingElement>("identity-manage-title");
  const manageClose = byId<HTMLButtonElement>("identity-manage-close");
  const manageDone = byId<HTMLButtonElement>("identity-manage-done");
  const managePubkey = byId<HTMLElement>("identity-manage-pubkey");
  const revealStart = byId<HTMLDivElement>("identity-reveal-start");
  const revealButton = byId<HTMLButtonElement>("identity-reveal");
  const exportError = byId<HTMLParagraphElement>("identity-export-error");
  const secretWrap = byId<HTMLDivElement>("identity-secret");
  const codeArea = byId<HTMLTextAreaElement>("identity-code");
  const filename = byId<HTMLElement>("identity-filename");
  const copyButton = byId<HTMLButtonElement>("identity-copy-code");
  const downloadButton = byId<HTMLButtonElement>("identity-download");
  const hideButton = byId<HTMLButtonElement>("identity-hide");

  let setupPromise: Promise<void> | null = null;
  let resolveSetup: (() => void) | null = null;
  let setupSettled = false;
  let importing = false;

  let exportGeneration = 0;
  let exportInFlight = false;

  function showChoiceStage(moveFocus: boolean): void {
    resetRestoreForm();
    choiceStage.hidden = false;
    restoreForm.hidden = true;
    if (moveFocus) showRestoreButton.focus();
  }

  function showRestoreStage(): void {
    choiceStage.hidden = true;
    restoreForm.hidden = false;
    restoreError.hidden = true;
    restoreError.textContent = "";
    restoreInput.removeAttribute("aria-invalid");
    restoreInput.focus();
  }

  function resetRestoreForm(): void {
    restoreInput.value = "";
    restoreInput.removeAttribute("aria-invalid");
    restoreInput.setAttribute("aria-describedby", "identity-restore-hint");
    restoreError.hidden = true;
    restoreError.textContent = "";
    restoreForm.removeAttribute("aria-busy");
    restoreSubmit.disabled = false;
    restoreSubmit.textContent = "Restore identity";
  }

  function setImporting(value: boolean): void {
    importing = value;
    restoreInput.disabled = value;
    restoreBack.disabled = value;
    restoreSubmit.disabled = value;
    restoreSubmit.textContent = value ? "Restoring…" : "Restore identity";
    restoreSubmit.setAttribute("aria-busy", String(value));
    restoreForm.setAttribute("aria-busy", String(value));
  }

  function setRestoreError(message: string): void {
    restoreError.textContent = message;
    restoreError.hidden = false;
    restoreInput.setAttribute("aria-invalid", "true");
    restoreInput.setAttribute(
      "aria-describedby",
      "identity-restore-hint identity-restore-error",
    );
  }

  function finishSetup(): void {
    if (setupSettled) return;
    setupSettled = true;
    resetRestoreForm();
    if (setupDialog.open) setupDialog.close();
    const resolve = resolveSetup;
    resolveSetup = null;
    resolve?.();
  }

  function requestIdentity(): Promise<void> {
    if (setupSettled) return Promise.resolve();

    if (!setupPromise) {
      setupPromise = new Promise<void>((resolve) => {
        resolveSetup = resolve;
      });
    }

    if (!setupDialog.open) {
      showChoiceStage(false);
      setupDialog.showModal();
      setupTitle.focus({ preventScroll: true });
    }
    return setupPromise;
  }

  function submitRestore(): void {
    if (importing || setupSettled) return;

    let decoded: DecodedIdentityBackup;
    try {
      decoded = decodeIdentityBackup(restoreInput.value);
    } catch (error) {
      setRestoreError(errorMessage(error));
      restoreInput.focus();
      return;
    }

    restoreError.hidden = true;
    restoreError.textContent = "";
    restoreInput.removeAttribute("aria-invalid");
    restoreInput.setAttribute("aria-describedby", "identity-restore-hint");
    setImporting(true);

    void (async () => {
      try {
        await deps.importIdentity(
          decoded.seed,
          decoded.nextSeq,
          decoded.contactsNextSeq,
        );
      } catch (error) {
        setImporting(false);
        setRestoreError(`Could not restore this identity. ${errorMessage(error)}`);
        restoreInput.focus();
        return;
      }

      setImporting(false);
      // Drop the secret from the DOM before the dialog closes.
      restoreInput.value = "";
      finishSetup();
      deps.onRestored();
    })();
  }

  createButton.addEventListener("click", () => {
    if (setupSettled || importing) return;
    finishSetup();
    deps.onCreate();
  });

  showRestoreButton.addEventListener("click", showRestoreStage);

  restoreBack.addEventListener("click", () => {
    if (importing) return;
    showChoiceStage(true);
  });

  restoreForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRestore();
  });

  restoreInput.addEventListener("input", () => {
    if (restoreError.hidden) return;
    restoreError.hidden = true;
    restoreError.textContent = "";
    restoreInput.removeAttribute("aria-invalid");
    restoreInput.setAttribute("aria-describedby", "identity-restore-hint");
  });

  // This dialog is the blocker: only the two explicit choices may dismiss it.
  setupDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });

  // Defensive: if something else closes it, reopen instead of letting the
  // board create a new identity by omission. `setupSettled` guards our close.
  setupDialog.addEventListener("close", () => {
    if (setupSettled) return;
    try {
      setupDialog.showModal();
      setupTitle.focus({ preventScroll: true });
    } catch {
      // Nothing is created while the board waits; a reload returns here.
    }
  });

  function setExportError(message: string | null): void {
    if (message === null) {
      exportError.hidden = true;
      exportError.textContent = "";
      return;
    }
    exportError.textContent = message;
    exportError.hidden = false;
  }

  function resetManageView(): void {
    exportGeneration += 1;
    exportInFlight = false;
    codeArea.value = "";
    secretWrap.hidden = true;
    revealStart.hidden = false;
    revealButton.disabled = false;
    revealButton.removeAttribute("aria-busy");
    revealButton.textContent = "Reveal backup code";
    setExportError(null);
  }

  function openManagement(): void {
    if (deps.offline) return;
    const current = deps.getIdentity();
    if (!current) return;

    resetManageView();
    managePubkey.textContent = current.pubkey;
    filename.textContent = identityBackupFilename(current.pubkey);

    if (!manageDialog.open) manageDialog.showModal();
    manageTitle.focus({ preventScroll: true });
  }

  function hideCode(moveFocus: boolean): void {
    codeArea.value = "";
    secretWrap.hidden = true;
    revealStart.hidden = false;
    if (moveFocus) revealButton.focus();
  }

  async function revealCode(): Promise<void> {
    if (exportInFlight) return;
    const generation = ++exportGeneration;
    exportInFlight = true;
    let failed = false;
    setExportError(null);
    revealButton.disabled = true;
    revealButton.setAttribute("aria-busy", "true");
    revealButton.textContent = "Preparing…";

    try {
      const secrets = await deps.exportIdentity();
      if (generation !== exportGeneration || !manageDialog.open) return;

      const pubkey = deps.getIdentity()?.pubkey;
      codeArea.value = encodeIdentityBackup(secrets, pubkey);
      filename.textContent = identityBackupFilename(pubkey);
      secretWrap.hidden = false;
      revealStart.hidden = true;
      codeArea.focus();
      codeArea.select();
      deps.announce("Backup code revealed. Treat it as the private key.");
    } catch (error) {
      if (generation === exportGeneration) {
        failed = true;
        setExportError(`Could not prepare the backup code. ${errorMessage(error)}`);
      }
    } finally {
      if (generation === exportGeneration) {
        exportInFlight = false;
        revealButton.disabled = false;
        revealButton.removeAttribute("aria-busy");
        revealButton.textContent = "Reveal backup code";
        if (failed && manageDialog.open) revealButton.focus();
      }
    }
  }

  revealButton.addEventListener("click", () => {
    void revealCode();
  });

  hideButton.addEventListener("click", () => {
    hideCode(true);
    deps.announce("Backup code hidden.");
  });

  copyButton.addEventListener("click", () => {
    const code = codeArea.value;
    if (!code) return;
    setExportError(null);
    void deps.copy(code, "Backup code", copyButton).then((copied) => {
      if (!copied) {
        setExportError(
          "Clipboard access was blocked. Select the code and copy it manually.",
        );
      }
    });
  });

  downloadButton.addEventListener("click", () => {
    const code = codeArea.value;
    if (!code) return;

    const name = identityBackupFilename(deps.getIdentity()?.pubkey);
    try {
      const blob = new Blob([code], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      deps.announce(`Backup downloaded as ${name}.`);
    } catch (error) {
      setExportError(
        `Could not download the backup. Copy the code instead. (${errorMessage(error)})`,
      );
    }
  });

  manageClose.addEventListener("click", () => manageDialog.close());
  manageDone.addEventListener("click", () => manageDialog.close());
  manageDialog.addEventListener("click", (event) => {
    if (event.target === manageDialog) manageDialog.close();
  });
  manageDialog.addEventListener("close", resetManageView);

  return { requestIdentity, openManagement };
}
