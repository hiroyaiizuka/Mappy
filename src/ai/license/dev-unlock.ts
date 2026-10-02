import type { Entitlement, EntitlementState } from './entitlement';

/**
 * The marker of the development unlock. `scripts/validate-release.mjs --artifacts` fails a packaged `main.js` that
 * contains it, and the ai-dev harness build must contain it (docs/architecture.md §11.6「開発用の解放」).
 */
export const DEV_UNLOCK_MARKER = 'mappy-ai-dev-unlock';

/**
 * Always `active`, with no store, no network and no clock: for the `feature/ai` development build only
 * (`MAPPY_AI_DEV_UNLOCK=1`). The release bundle never reaches this class, so esbuild leaves it out.
 */
export class DevUnlockEntitlement implements Entitlement {
  readonly marker = DEV_UNLOCK_MARKER;
  private readonly active: EntitlementState = { kind: 'active', expiresAt: Number.MAX_SAFE_INTEGER };
  load(): Promise<EntitlementState> { return Promise.resolve(this.active); }
  state(): EntitlementState { return this.active; }
  onChange(): () => void { return () => undefined; }
  register(): Promise<EntitlementState> { return Promise.resolve(this.active); }
  refresh(): Promise<EntitlementState> { return Promise.resolve(this.active); }
  dispose(): void { /* Nothing to release. */ }
}
