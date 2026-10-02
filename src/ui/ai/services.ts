import type { TFile } from "obsidian";
import type { AiFailure, AiMaterial, AiRunner } from "../../ai/contract";

/**
 * The license state as the AI's entrance reads it: the kinds of §11.6's `EntitlementState` (LEV-273), so that
 * `Entitlement.state()` passes here as it is.
 */
export interface AiEntitlementView {
  kind: "checking" | "unregistered" | "active" | "expired" | "unreachable" | "invalid";
  reason?: string;
}

/**
 * What the map's AI (案 A, LEV-271) needs from the plugin, wired in `src/main.ts` once the license gate (LEV-273) and
 * the runner (LEV-270) are in (docs/architecture.md §11.8: the third of the three to merge wires them). The view knows
 * the runner only as `AiRunner`, and neither Node nor the license server: a view given no services shows no AI.
 */
export interface AiServices {
  /** `Entitlement.state()`: the button shows for `active`, `expired` and `unreachable` only (§11.6). */
  state(): AiEntitlementView;
  /** `Entitlement.onChange`; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** `Entitlement.refresh()`: the button pressed while `expired` or `unreachable`; the input opens once it is `active`. */
  refresh(): Promise<AiEntitlementView>;
  /** `runnerFactory.create()` (§11.1, §11.6): null unless `active`, as checked when it is called. */
  createRunner(): AiRunner | null;
  /** The engine the settings choose (`data.json`, §11.3); the input can switch it for one run. */
  defaultEngine(): "claude" | "codex";
  /**
   * An attachment of the input read as a material (§11.2: a note through `DocumentStore.read`, a PDF through pdf.js;
   * LEV-270's `material.ts`). Rejects with an `AiAttachmentError` naming the failure to show (`no-pdf-text`,
   * `material-too-large`); anything else it rejects with is shown as `material-failed`.
   */
  readAttachment(file: TFile): Promise<AiMaterial>;
  /**
   * A runner that answers without any CLI, offered in the input as one more engine: given only by a build with the
   * development unlock (`MAPPY_AI_DEV_UNLOCK`, §11.6), so the real E2E can run the whole UI on the test vault.
   */
  fakeRunner?: AiRunner;
}

/** Why an attachment could not be read (`AiServices.readAttachment`): the failure the card names, and its detail. */
export class AiAttachmentError extends Error {
  constructor(readonly reason: AiFailure, detail: string) { super(detail); }
}

/**
 * One run at a time in the whole of Mappy (§11.3): every map view asks this before it starts a run, and its AI
 * button is disabled while another view's run is under way. No queue and no retry: a run asked for meanwhile is
 * refused, and the user presses again.
 */
export class AiRunLock {
  private owner: object | null = null;
  private readonly listeners = new Set<() => void>();

  /** Whether a run holds the lock. The owner is the run itself, so a view's next run is not its last one. */
  busy(): boolean {
    return this.owner !== null;
  }

  take(owner: object): boolean {
    if (this.owner !== null) return false;
    this.owner = owner;
    this.notify();
    return true;
  }

  release(owner: object): void {
    if (this.owner !== owner) return;
    this.owner = null;
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/** The lock every view of this plugin shares. */
export const aiRunLock = new AiRunLock();
