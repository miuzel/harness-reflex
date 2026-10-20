/**
 * Stateful core of the Reflex settings page.
 *
 * One store owns both halves of the page: the live metrics it polls from the
 * Host's `/api/dsh-reflex/panel` route, and the editable draft it derives from
 * the Host settings form for the resolved namespace. It is deliberately free of
 * React and of any browser global — `fetch`, `configForms`, and the clock are
 * injected — so the page's state machine can be driven by `node --test`.
 *
 * Two rules shape it:
 *
 * - **The Host stays the fact source.** The draft is re-seeded from the Host's
 *   section whenever the user has no unsaved edit, so a concurrent settings
 *   change elsewhere in the GUI cannot be silently overwritten by a stale form.
 * - **Writes are fenced.** Every save carries the revision the draft was read
 *   at, and a refused or failed write is reported instead of being retried
 *   blindly.
 *
 * @module dsh-reflex/client/store
 */
import {
  addPool,
  addPoolEntry,
  diffDraft,
  dirtyGroups,
  draftFromConfig,
  draftFromSnapshot,
  movePoolEntry,
  removePool,
  removePoolEntry,
  validateDraft,
  type PanelDraft,
  type PanelSnapshotLike,
  type SettingsOp
} from './panel';

/** Pages of the panel. */
export type PanelTab = 'overview' | 'routing' | 'effort' | 'backend' | 'interventions' | 'tools' | 'ledger' | 'guide';

/** Every page, in navigation order. */
export const PANEL_TABS: readonly PanelTab[] = [
  'overview',
  'routing',
  'effort',
  'backend',
  'interventions',
  'tools',
  'ledger',
  'guide'
];

/** One Host settings section, as the client form API reports it. */
export interface FormSnapshotLike {
  status: 'loading' | 'ready' | 'unavailable';
  value: unknown;
  revision: number | undefined;
  writable: boolean;
}

/** The slice of `ConfigForm` this store uses. */
export interface ConfigFormLike {
  getSnapshot(): FormSnapshotLike;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly SettingsOp[], expectedRevision?: number): Promise<boolean>;
}

/** The slice of `window.fetch` this store uses. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Request options this store passes; the panel only ever reads and clears. */
export interface FetchInitLike {
  method?: string;
}

/** Injection seams of {@link PanelStore}. */
export interface PanelStoreOptions {
  /** Settings form of the resolved namespace. */
  form: ConfigFormLike;
  /** `window.fetch` (or a test double). */
  fetch: (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;
  /** Origin prefix of the panel routes; empty for same-origin. */
  basePath?: string;
  /** Poll period for live metrics; `0` disables polling. */
  pollIntervalMs?: number;
  /** Clock seam. */
  now?: () => number;
  /** Timer seams; `setTimer` receives the delay in milliseconds. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Everything the page renders from. */
export interface PanelState {
  tab: PanelTab;
  /** Live-metric read state. */
  phase: 'idle' | 'loading' | 'ready' | 'error';
  snapshot: PanelSnapshotLike | null;
  error: string | null;
  fetchedAt: number | null;
  /** Settings-section state. */
  configStatus: 'loading' | 'ready' | 'unavailable';
  writable: boolean;
  revision: number | undefined;
  /** Draft seeded from the Host, and the edited draft derived from it. */
  original: PanelDraft;
  draft: PanelDraft;
  /** Copy keys of the draft's validation problems. */
  errors: string[];
  saving: boolean;
  /** Copy key of the last outcome, if any. */
  notice: string | null;
  noticeValues: Record<string, string> | null;
  /** Whether the next clear request is the confirming one. */
  confirmingClear: boolean;
}

/** Route of the live snapshot, relative to {@link PanelStoreOptions.basePath}. */
export const SNAPSHOT_PATH = '/dsh-reflex/api/panel';

/** Route that clears the ledger. */
export const CLEAR_PATH = '/dsh-reflex/api/ledger/clear?confirm=clear';

/** Default poll period, in milliseconds. */
export const DEFAULT_POLL_MS = 4000;

/** Read a nested error message out of an unknown failure. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

/**
 * Observable state of the Reflex settings page.
 *
 * Immutable snapshots, one listener list: the React layer subscribes through
 * `useSyncExternalStore`-shaped calls, which need a stable reference per change.
 */
export class PanelStore {
  readonly #options: PanelStoreOptions;
  readonly #basePath: string;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #listeners = new Set<() => void>();
  #state: PanelState;
  #timer: unknown;
  #disposed = false;
  #formUnsubscribe: (() => void) | undefined;

  /**
   * @param options - the settings form, a fetch implementation, and timing seams.
   */
  constructor(options: PanelStoreOptions) {
    this.#options = options;
    this.#basePath = options.basePath ?? '';
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const form = options.form.getSnapshot();
    const seeded = draftFromConfig(form.value);
    this.#state = {
      tab: 'overview',
      phase: 'idle',
      snapshot: null,
      error: null,
      fetchedAt: null,
      configStatus: form.status,
      writable: form.writable,
      revision: form.revision,
      original: seeded,
      draft: seeded,
      errors: [],
      saving: false,
      notice: null,
      noticeValues: null,
      confirmingClear: false
    };
  }

  /** @returns the current immutable state. */
  getState(): PanelState {
    return this.#state;
  }

  /**
   * Observe state replacements.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Start the polling loop and follow the Host settings section. */
  start(): void {
    if (this.#disposed) return;
    this.#formUnsubscribe = this.#options.form.subscribe(() => {
      this.#adoptForm();
    });
    void this.refresh();
  }

  /** Stop polling and release the form subscription. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    this.#formUnsubscribe?.();
    this.#formUnsubscribe = undefined;
  }

  /**
   * Read the live snapshot, then schedule the next read.
   * @returns settlement once the read has been folded into the state.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#set({ phase: this.#state.snapshot === null ? 'loading' : this.#state.phase, error: null });
    try {
      const response = await this.#options.fetch(`${this.#basePath}${SNAPSHOT_PATH}`);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = (await response.json()) as PanelSnapshotLike;
      if (this.#disposed) return;
      const dirty = dirtyGroups(this.#state.original, this.#state.draft).length > 0;
      if (!dirty) {
        const enhanced = draftFromSnapshot(body, this.#state.draft);
        this.#set({
          phase: 'ready',
          snapshot: body,
          fetchedAt: this.#now(),
          original: enhanced,
          draft: enhanced,
          error: null
        });
      } else {
        this.#set({ phase: 'ready', snapshot: body, fetchedAt: this.#now(), error: null });
      }
    } catch (error) {
      if (this.#disposed) return;
      this.#set({ phase: 'error', error: messageOf(error) });
    } finally {
      this.#schedule();
    }
  }

  /**
   * Switch page.
   * @param tab - the page to show.
   */
  setTab(tab: PanelTab): void {
    if (this.#state.tab === tab) return;
    this.#set({ tab });
  }

  /**
   * Edit the draft in place.
   * @param mutate - receives the current draft; returns the next one.
   */
  edit(mutate: (draft: PanelDraft) => PanelDraft): void {
    const draft = mutate(this.#state.draft);
    const { errors } = validateDraft(draft);
    this.#set({ draft, errors, notice: null, noticeValues: null });
  }

  /**
   * Edit the routing draft's model pools.
   * @param mutate - receives the current pools; returns the next ones.
   */
  editPools(mutate: (pools: PanelDraft['routing']['pools']) => PanelDraft['routing']['pools']): void {
    this.edit((draft) => ({ ...draft, routing: { ...draft.routing, pools: mutate(draft.routing.pools) } }));
  }

  /** Append an empty virtual model. */
  addPool(): void {
    this.editPools((pools) => addPool(pools));
  }

  /**
   * Remove one virtual model.
   * @param index - its position.
   */
  removePool(index: number): void {
    this.editPools((pools) => removePool(pools, index));
  }

  /**
   * Append an empty candidate to one pool.
   * @param index - the pool's position.
   */
  addCandidate(index: number): void {
    this.editPools((pools) => addPoolEntry(pools, index));
  }

  /**
   * Remove one candidate.
   * @param index - the pool's position.
   * @param entry - the candidate's position.
   */
  removeCandidate(index: number, entry: number): void {
    this.editPools((pools) => removePoolEntry(pools, index, entry));
  }

  /**
   * Reorder one candidate, which is the pool's routing preference.
   * @param index - the pool's position.
   * @param entry - the candidate's position.
   * @param delta - `-1` to promote, `1` to demote.
   */
  moveCandidate(index: number, entry: number, delta: number): void {
    this.editPools((pools) => movePoolEntry(pools, index, entry, delta));
  }

  /** Discard unsaved edits and re-seed from the Host. */
  reset(): void {
    const seeded = draftFromConfig(this.#options.form.getSnapshot().value);
    this.#set({ draft: seeded, original: seeded, errors: [], notice: null, noticeValues: null });
  }

  /**
   * Write the draft's changed groups to the Host.
   *
   * A no-op when nothing changed; a refusal (rather than a throw) when the draft
   * is invalid or the document is read-only, so the page can show the reason
   * without a network round trip.
   * @returns whether the Host accepted the write.
   */
  async save(): Promise<boolean> {
    const { draft, original, revision } = this.#state;
    // The button is disabled for a read-only document; refusing here as well keeps
    // every other caller of `save()` (a keyboard shortcut, a future auto-save)
    // from writing a document the Host said it will not accept.
    if (!this.#state.writable) return false;
    const validation = validateDraft(draft);
    if (!validation.ok) {
      this.#set({ errors: validation.errors, notice: null, noticeValues: null });
      return false;
    }
    const ops = diffDraft(original, draft);
    if (ops.length === 0) {
      this.#set({ errors: [], notice: 'clean', noticeValues: null });
      return true;
    }
    this.#set({ saving: true, errors: [], notice: null, noticeValues: null });
    try {
      const accepted = await this.#options.form.mutate(ops, revision);
      if (this.#disposed) return accepted;
      if (!accepted) {
        this.#set({ saving: false, notice: 'confirmRejected', noticeValues: null });
        return false;
      }
      const seeded = draftFromConfig(this.#options.form.getSnapshot().value);
      this.#set({ saving: false, original: seeded, draft: seeded, notice: 'saved', noticeValues: null });
      void this.refresh();
      return true;
    } catch (error) {
      if (this.#disposed) return false;
      this.#set({ saving: false, error: messageOf(error), notice: null, noticeValues: null });
      return false;
    }
  }

  /**
   * Clear the Host ledger, asking for confirmation first.
   *
   * The first call only arms the confirmation, because the request also deletes
   * the ledger's JSONL sink; the second, unchanged-state call performs it.
   * @returns whether a clear was actually attempted.
   */
  async clearLedger(): Promise<boolean> {
    if (!this.#state.confirmingClear) {
      this.#set({ confirmingClear: true, notice: null, noticeValues: null });
      return false;
    }
    this.#set({ confirmingClear: false });
    try {
      const response = await this.#options.fetch(`${this.#basePath}${CLEAR_PATH}`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body = (await response.json()) as { cleared?: number };
      if (this.#disposed) return true;
      this.#set({ notice: 'ledgerCleared', noticeValues: { count: String(body.cleared ?? 0) } });
      await this.refresh();
      return true;
    } catch (error) {
      if (this.#disposed) return false;
      this.#set({ error: messageOf(error), notice: null, noticeValues: null });
      return false;
    }
  }

  /** Disarm a pending clear confirmation. */
  cancelClear(): void {
    if (this.#state.confirmingClear) this.#set({ confirmingClear: false });
  }

  /** Fold a Host settings-section change into the state. */
  #adoptForm(): void {
    if (this.#disposed) return;
    const form = this.#options.form.getSnapshot();
    const dirty = dirtyGroups(this.#state.original, this.#state.draft).length > 0;
    if (dirty) {
      // Keep the user's work, but follow the revision so the next write fences
      // against what the Host actually holds.
      this.#set({ configStatus: form.status, writable: form.writable, revision: form.revision });
      return;
    }
    const seeded = draftFromConfig(form.value);
    this.#set({
      configStatus: form.status,
      writable: form.writable,
      revision: form.revision,
      original: seeded,
      draft: seeded,
      errors: []
    });
  }

  /** Schedule the next poll, unless polling is disabled. */
  #schedule(): void {
    const interval = this.#options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (this.#disposed || interval <= 0) return;
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.refresh();
    }, interval);
  }

  /** Replace state and notify. */
  #set(patch: Partial<PanelState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
