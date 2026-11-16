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
  draftFromLayers,
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

/**
 * One Host settings section, as the client form API reports it.
 *
 * `value` is the *effective* section and does not include the profile's compose
 * base, so a deployment configured entirely in `cordis.patch.yml` shows its
 * values in `base` and an empty `value`. `user` is the raw layer this panel
 * writes to; its presence is what marks a field as overridden.
 */
export interface FormSnapshotLike {
  status: 'loading' | 'ready' | 'unavailable';
  value: unknown;
  /** Composition layer `value` was resolved over; absent on older bridges. */
  base?: unknown;
  /** Raw user layer as stored; absent on older bridges. */
  user?: unknown;
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
  /** Request headers; the probe route needs a JSON content type. */
  headers?: Record<string, string>;
  /** Request body; the probe route names the profile here. */
  body?: string;
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
  /** Outcome of the last host-patch write, as the host reported it. */
  delegationWrite: DelegationWriteState | null;
  /**
   * Connection-test results, keyed by profile name (empty string = the flat
   * block). One entry per row, replaced as its own probe answers, so concurrent
   * tests of different rows cannot overwrite each other's result.
   */
  probes: Record<string, ProbeState>;
}

/**
 * What one row's test button shows.
 *
 * `testing` is a distinct phase rather than "the last result is stale": a row
 * that is being probed must look busy, not keep showing an old green tick.
 */
export interface ProbeState {
  phase: 'testing' | 'done' | 'error';
  result?: ProbeResultLike;
  /** Why the request itself failed (a non-2xx panel answer). */
  error?: string;
}

/** The classification one probe answered, as the page renders it. */
export interface ProbeResultLike {
  ok?: boolean;
  status?: string;
  latencyMs?: number;
  profile?: string | null;
  httpStatus?: number;
  detail?: string;
  model?: string;
  endpoint?: string;
}

/** What the last host-profile-patch write returned. */
export interface DelegationWriteState {
  /** The host's outcome vocabulary (`added-field`, `already-enabled`, …). */
  outcome: string;
  /** Whether a DSH restart is needed for it to take effect. */
  restartRequired: boolean;
  /** Path edited, when the host reports one. */
  path?: string;
  /** Why nothing was written, when nothing was. */
  reason?: string;
}

/** Route of the live snapshot, relative to {@link PanelStoreOptions.basePath}. */
export const SNAPSHOT_PATH = '/dsh-reflex/api/panel';

/** Route that clears the ledger. */
export const CLEAR_PATH = '/dsh-reflex/api/ledger/clear?confirm=clear';

/**
 * Route that writes the host `modelSelection` switch.
 *
 * The `confirm=delegation` query is the host's own requirement: this is the only
 * request of the page that edits a file outside the plugin's settings section,
 * so it may not be fired by an accidental GET.
 */
export const DELEGATION_PATH = '/dsh-reflex/api/delegation?confirm=delegation';

/**
 * Route that probes one System One profile.
 *
 * A `POST` because it makes the Host perform outbound work; the body names the
 * profile, and an empty name asks for the active one.
 */
export const SYSTEMONE_TEST_PATH = '/dsh-reflex/api/systemone/test';

/** Default poll period, in milliseconds. */
export const DEFAULT_POLL_MS = 4000;

/** Read a nested error message out of an unknown failure. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

/**
 * Seed a draft from one settings section.
 *
 * The Host reports two layers: `value` (effective, with the profile's compose
 * base already folded in) and `base` (that compose base on its own). A
 * deployment configured in `cordis.patch.yml` — which is how a patch-layer user
 * configures this plugin — puts nothing in `value` itself, so reading only
 * `value` would show an empty page for a running configuration. `base` is the
 * fallback for every group the panel owns; `routing` merges per virtual model so
 * a pool added in one layer is not hidden by the other.
 *
 * @param form - the settings form snapshot.
 * @returns the draft to edit.
 */
export function draftFromForm(form: FormSnapshotLike): PanelDraft {
  return draftFromLayers(form.value, form.base);
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
    const seeded = draftFromForm(form);
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
      confirmingClear: false,
      delegationWrite: null,
      probes: {}
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
  /**
   * Probe one profile's connection from the Host and record the answer.
   *
   * The key never travels with this request: the server reads it from the
   * resolved profile and only returns a classification. Each row owns its own
   * state slot, so a slow row cannot overwrite the answer a fast row just got.
   *
   * @param profile - profile name, or `''` to probe the flat block / active profile.
   * @returns whether a result was recorded.
   */
  async testSystemOne(profile: string): Promise<boolean> {
    const key = profile;
    this.#set({ probes: { ...this.#state.probes, [key]: { phase: 'testing' } } });
    try {
      const response = await this.#options.fetch(`${this.#basePath}${SYSTEMONE_TEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // An empty name is simply omitted, which the Host reads as "the active one".
        body: JSON.stringify(key.length === 0 ? {} : { profile: key })
      });
      const body = (await response.json().catch(() => ({}))) as ProbeResultLike & { error?: string; detail?: string };
      if (this.#disposed) return false;
      if (!response.ok) {
        // A refused request (403/405/501/413) is not a connection verdict, so it
        // is reported as an error rather than as "unreachable".
        this.#set({
          probes: { ...this.#state.probes, [key]: { phase: 'error', error: body.detail ?? body.error ?? `HTTP ${String(response.status)}` } }
        });
        return false;
      }
      this.#set({ probes: { ...this.#state.probes, [key]: { phase: 'done', result: body } } });
      return true;
    } catch (error) {
      if (this.#disposed) return false;
      this.#set({ probes: { ...this.#state.probes, [key]: { phase: 'error', error: messageOf(error) } } });
      return false;
    }
  }

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

  /**
   * Append one empty profile row, so the user has something to name and fill.
   *
   * The row carries no name yet: an unnamed row cannot become a settings path,
   * so {@link groupWrites} skips it until the user names it. A default name is
   * *not* invented — two clicks would then collide on it.
   */
  addProfile(): void {
    this.edit((draft) => ({
      ...draft,
      backend: {
        ...draft.backend,
        profiles: [
          ...draft.backend.profiles,
          {
            name: '',
            baseUrl: '',
            model: '',
            apiKeyEnv: '',
            timeoutMs: '',
            backend: '',
            apiKey: '',
            apiKeyPresent: false,
            apiKeyFromProfile: false,
            apiKeyVariable: '',
            clearKey: false
          }
        ]
      }
    }));
  }

  /**
   * Remove one profile row by name.
   *
   * Removing the active profile also clears `active`, so the settings document
   * never names a profile the user just deleted (which would resolve as the
   * `activeProfileMissing` fallback until the next save).
   * @param name - the row's profile name.
   */
  removeProfile(name: string): void {
    this.edit((draft) => {
      const profiles = draft.backend.profiles.filter((row) => row.name.trim() !== name);
      const active = draft.backend.active.trim() === name ? '' : draft.backend.active;
      return { ...draft, backend: { ...draft.backend, profiles, active } };
    });
  }

  /** Discard unsaved edits and re-seed from the Host. */
  reset(): void {
    const seeded = draftFromForm(this.#options.form.getSnapshot());
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
    // The raw user layer is passed so a group write keeps the keys this page
    // never rendered instead of replacing the whole section with them dropped.
    const ops = diffDraft(original, draft, this.#options.form.getSnapshot().user);
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
      const seeded = draftFromForm(this.#options.form.getSnapshot());
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

  /**
   * Write the host `modelSelection` switch, then refresh the live facts.
   *
   * Called by the toggle *after* the settings save that records the consent, so
   * the two writes are separate: the settings document says "the user agreed",
   * and this request edits the profile patch. A failure here leaves the consent
   * recorded and reports the host's reason, rather than silently un-ticking a
   * box the user did press.
   * @returns whether the host accepted the write.
   */
  async enableDelegation(): Promise<boolean> {
    this.#set({ delegationWrite: null, errors: [] });
    try {
      const response = await this.#options.fetch(`${this.#basePath}${DELEGATION_PATH}`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        outcome?: string;
        restartRequired?: boolean;
        path?: string;
        reason?: string;
        error?: string;
        detail?: string;
      };
      if (this.#disposed) return false;
      if (!response.ok || body.ok !== true) {
        this.#set({
          delegationWrite: {
            outcome: 'refused',
            restartRequired: false,
            ...(body.detail === undefined ? {} : { reason: body.detail })
          }
        });
        return false;
      }
      this.#set({
        delegationWrite: {
          outcome: String(body.outcome ?? 'unknown'),
          restartRequired: body.restartRequired === true,
          ...(body.path === undefined ? {} : { path: body.path }),
          ...(body.reason === undefined ? {} : { reason: body.reason })
        }
      });
      await this.refresh();
      return true;
    } catch (error) {
      if (this.#disposed) return false;
      this.#set({ delegationWrite: { outcome: 'refused', restartRequired: false, reason: messageOf(error) } });
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
    const seeded = draftFromForm(form);
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
