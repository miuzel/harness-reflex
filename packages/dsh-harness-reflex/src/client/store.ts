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
  createProfileRowId,
  diffDraft,
  dirtyGroups,
  draftFromConfig,
  draftFromLayers,
  draftFromSnapshot,
  movePoolEntry,
  removePool,
  removePoolEntry,
  reseedProfileRows,
  unnamedFilledRows,
  validateDraft,
  type PanelDraft,
  type PanelSnapshotLike,
  type ProfileDraft,
  type SettingsOp
} from './panel';
import { planRenameSecrets } from './rename-secrets';

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
  /**
   * Values the error copy interpolates, by copy key.
   *
   * `errors` holds keys only, so an error that has to name *which* row is wrong
   * (g-064) carries its row numbers here rather than in the key.
   */
  errorValues: Record<string, string>;
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
 * One blank profile row carrying its page identity.
 * @param id - the identity minted for this row, never persisted.
 * @returns the row as the draft holds it.
 */
function blankProfileRow(id: string): ProfileDraft {
  return {
    id,
    name: '',
    baseUrl: '',
    modelIds: '',
    selectedModel: '',
    legacyModelShape: false,
    apiKeyEnv: '',
    timeoutMs: '',
    backend: '',
    apiKey: '',
    apiKeyPresent: false,
    apiKeyFromProfile: false,
    apiKeyVariable: '',
    // A blank row has locked onto nothing yet: `env` is the neutral tag until
    // the Host reports where a saved row's key really comes from.
    apiKeySource: 'env',
    apiKeyLocked: false,
    clearKey: false
  };
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
 * Seed the draft from the settings document, keeping the profile rows on screen.
 *
 * A re-seed is a *re-read* of the document, not a reset of the user's work: the
 * profile rows are the one part of the draft the document does not describe
 * faithfully, because an unnamed row is not written to it at all (g-062). The
 * rows in force are therefore carried across, identity included — see
 * {@link reseedProfileRows} — so a save can no longer wipe the row the user was
 * still filling in, and `data-profile` stays stable across a write.
 *
 * @param form - the settings form snapshot.
 * @param previous - the profile rows currently on screen, if any.
 * @returns the draft to edit.
 */
export function draftFromFormKeepingRows(form: FormSnapshotLike, previous: readonly ProfileDraft[]): PanelDraft {
  const seeded = draftFromForm(form);
  if (previous.length === 0) return seeded;
  return { ...seeded, backend: { ...seeded.backend, profiles: reseedProfileRows(previous, seeded.backend.profiles) } };
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
    // The initial validation runs through `validateDraft` rather than a literal
    // `[]`: an array built here is created in the *caller's* realm, and the client
    // tests evaluate this module inside a VM, where `deepEqual(errors, [])` then
    // fails on the prototype rather than the (empty) content.
    const initial = validateDraft(seeded);
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
      errors: initial.errors,
      errorValues: initial.values,
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
   * Only a **saved** profile can be tested: a probe reads the document the Host
   * has, so a row that is not saved has nothing to test (g-062). An empty name
   * is refused here as well as at the button, because the old empty name meant
   * "probe the flat block" — a connection that no longer exists (g-066).
   * @param profile - profile name.
   * @returns whether a result was recorded.
   */
  async testSystemOne(profile: string): Promise<boolean> {
    const key = profile.trim();
    if (key.length === 0) return false;
    this.#set({ probes: { ...this.#state.probes, [key]: { phase: 'testing' } } });
    try {
      const response = await this.#options.fetch(`${this.#basePath}${SYSTEMONE_TEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: key })
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
   *
   * A rename carries the activation with the row (g-065): `active` is a *name*,
   * so renaming the row the document has activated would otherwise leave
   * `active` pointing at a name that no longer exists — the document would then
   * name a missing profile (`activeProfileMissing`) even though the row the user
   * activated is right there under its new name. The row's identity is what ties
   * the two together, exactly as it does in {@link removeProfile}.
   * @param mutate - receives the current draft; returns the next one.
   */
  edit(mutate: (draft: PanelDraft) => PanelDraft): void {
    const draft = this.#followRenamedActivation(this.#state.draft, mutate(this.#state.draft));
    const { errors, values } = validateDraft(draft);
    this.#set({ draft, errors, errorValues: values, notice: null, noticeValues: null });
  }

  /**
   * Re-point `active` at the row it named, when that row was just renamed.
   *
   * Only a rename is followed: when the old name still belongs to a row in the
   * next draft, nothing was renamed away from it and the marker is left alone.
   * A name the user typed into `active` by other means is unaffected, because
   * the transition is detected per row identity, not by reading `active` alone.
   * @param before - the draft before the edit.
   * @param after - the draft the edit produced.
   * @returns `after`, with `active` moved to the renamer's new name if needed.
   */
  #followRenamedActivation(before: PanelDraft, after: PanelDraft): PanelDraft {
    const active = after.backend.active.trim();
    if (active.length === 0) return after;
    // A row still carries the activated name: no rename moved it away.
    if (after.backend.profiles.some((row) => row.name.trim() === active)) return after;
    const wasActive = before.backend.profiles.find((row) => row.name.trim() === active);
    if (wasActive === undefined) return after;
    // The same row, under whatever name it now carries (blank = unnamed again,
    // which cannot be activated; the marker is cleared with the row).
    const renamed = after.backend.profiles.find((row) => row.id === wasActive.id);
    if (renamed === undefined) return after;
    return { ...after, backend: { ...after.backend, active: renamed.name.trim() } };
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
   * *not* invented — two clicks would then collide on it. Its page identity is
   * minted here ({@link createProfileRowId}), never derived from the name.
   */
  addProfile(): void {
    this.edit((draft) => ({
      ...draft,
      backend: {
        ...draft.backend,
        profiles: [...draft.backend.profiles, blankProfileRow(createProfileRowId())]
      }
    }));
  }

  /**
   * Remove exactly one profile row, addressed by its page identity.
   *
   * The row is found by `id`, never by name (g-062): every unnamed row shares
   * the name `''`, so a name filter used to delete all of them at once.
   *
   * Removing the active profile also clears `active`, so the settings document
   * never names a profile the user just deleted (which would resolve as the
   * `activeProfileMissing` fallback until the next save).
   * @param id - the row's page identity.
   */
  removeProfile(id: string): void {
    this.edit((draft) => {
      const removed = draft.backend.profiles.find((row) => row.id === id);
      if (removed === undefined) return draft;
      const name = removed.name.trim();
      const profiles = draft.backend.profiles.filter((row) => row.id !== id);
      // Only the row actually deleted may clear `active`; two rows can share a
      // name in the draft before a save, and the survivor keeps the marker.
      const stillActivated = profiles.some((row) => row.name.trim() === name);
      const wasActive = name.length > 0 && draft.backend.active.trim() === name && !stillActivated;
      return { ...draft, backend: { ...draft.backend, profiles, active: wasActive ? '' : draft.backend.active } };
    });
  }

  /**
   * Make one row the active profile, addressed by its page identity.
   *
   * Activation is recorded in the *draft* ({@link PanelDraft.backend}.active),
   * so it is visible at once and only reaches the settings document on save.
   * An unnamed row has no name to activate — the page disables that action and
   * this method refuses it, so a stale click can never write `active: ''`.
   * @param id - the row's page identity.
   * @returns whether the row could be activated.
   */
  setActiveProfile(id: string): boolean {
    const row = this.#state.draft.backend.profiles.find((candidate) => candidate.id === id);
    if (row === undefined || row.name.trim().length === 0) return false;
    const name = row.name.trim();
    if (this.#state.draft.backend.active.trim() === name) return true;
    this.edit((draft) => ({ ...draft, backend: { ...draft.backend, active: name } }));
    return true;
  }

  /**
   * Probe one row's connection, addressed by its page identity.
   *
   * The Host probes the *saved* document (its own resolution chain), so only a
   * row whose name the Host already knows can be tested; the page disables the
   * action otherwise. The result is still filed under the profile name, which
   * is what the probe route is addressed by.
   * @param id - the row's page identity.
   * @param saved - the profile names the Host's snapshot reports, which is the
   *   set it can actually probe.
   * @returns settlement once the probe answered, or `false` without a request.
   */
  async testProfile(id: string, saved: ReadonlySet<string>): Promise<boolean> {
    const row = this.#state.draft.backend.profiles.find((candidate) => candidate.id === id);
    const name = row?.name.trim() ?? '';
    if (name.length === 0 || !saved.has(name)) return false;
    return this.testSystemOne(name);
  }

  /** Discard unsaved edits and re-seed from the Host. */
  reset(): void {
    // An explicit reset is the one re-seed that may drop the user's work, but a
    // row's page identity survives it: the Host answers for the same saved rows,
    // so the markers it drives would otherwise be renumbered under the pointer.
    const seeded = draftFromFormKeepingRows(this.#options.form.getSnapshot(), this.#state.draft.backend.profiles);
    this.#set({ draft: seeded, original: seeded, errors: [], errorValues: {}, notice: null, noticeValues: null });
  }

  /**
   * Write the draft's changed groups to the Host.
   *
   * A renamed or deleted row is retired in the *same* operation list as the
   * write of its new path (g-065): the old `systemOne.profiles.<old>` subtree is
   * an `unset` and the new name's fields are `set`s in one `mutate`, so the Host
   * applies both or neither and can never keep a renamed-away profile behind.
   * {@link diffDraft} derives both sides from `original` versus `draft`.
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
      this.#set({ errors: validation.errors, errorValues: validation.values, notice: null, noticeValues: null });
      return false;
    }
    // Write-only keys are the one thing a rename can destroy without a trace
    // (g-066): the secret cannot be restated by this page, and the Host retires
    // the old subtree in the same save. The save is refused — before any op is
    // built — while a renamed row would lose a stored key that the draft does
    // not restate, so the user retypes it instead of finding out at the next
    // auth failure. `planRenameSecrets` documents each case.
    const secrets = planRenameSecrets(original, draft);
    if (secrets.blocked.length > 0) {
      const rows = secrets.blocked.map((entry) => `${entry.from} → ${entry.to}`).join(', ');
      this.#set({
        errors: ["errProfileRenameKey"],
        errorValues: { errProfileRenameKey: rows },
        notice: null,
        noticeValues: null
      });
      return false;
    }
    // The raw user layer is passed so a group write keeps the keys this page
    // never rendered instead of replacing the whole section with them dropped.
    const ops = diffDraft(original, draft, this.#options.form.getSnapshot().user);
    if (ops.length === 0) {
      // "Nothing to write" is only "clean" when the draft really is what the Host
      // holds. An unnamed row contributes no op on either side of the diff, so a
      // page carrying one came out of the diff *empty* and reported success while
      // writing nothing — the row vanished, the page stayed dirty and the row was
      // never testable (g-064). Validation refuses that draft, so reaching this
      // with one would be a regression in the rule above; it is reported instead
      // of claimed clean (fail closed), never silently accepted.
      const unnamed = unnamedFilledRows(draft);
      if (unnamed.length > 0) {
        this.#set({ errors: ['errProfileName'], errorValues: { errProfileName: unnamed.join(', ') }, notice: null, noticeValues: null });
        return false;
      }
      // A *blank* unnamed row is allowed by the rule and by the page, but it is
      // still a draft the Host does not hold: reporting "clean" left the page's
      // dirty badge on forever (the early return never re-seeds `original`).
      // It survives this re-seed by identity — `draftFromFormKeepingRows` keeps
      // the page's own rows — so it is still there to be named.
      const seeded = draftFromFormKeepingRows(this.#options.form.getSnapshot(), this.#state.draft.backend.profiles);
      this.#set({ errors: [], errorValues: {}, original: seeded, draft: seeded, notice: 'clean', noticeValues: null });
      return true;
    }
    this.#set({ saving: true, errors: [], errorValues: {}, notice: null, noticeValues: null });
    try {
      const accepted = await this.#options.form.mutate(ops, revision);
      if (this.#disposed) return accepted;
      if (!accepted) {
        this.#set({ saving: false, notice: 'confirmRejected', noticeValues: null });
        return false;
      }
      const seeded = draftFromFormKeepingRows(this.#options.form.getSnapshot(), this.#state.draft.backend.profiles);
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
    this.#set({ delegationWrite: null, errors: [], errorValues: {} });
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
    const seeded = draftFromFormKeepingRows(form, this.#state.draft.backend.profiles);
    this.#set({
      configStatus: form.status,
      writable: form.writable,
      revision: form.revision,
      original: seeded,
      draft: seeded,
      errors: [],
      errorValues: {}
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
