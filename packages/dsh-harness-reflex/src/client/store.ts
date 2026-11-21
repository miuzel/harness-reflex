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
import { Autosave, type AutosaveEntry, type AutosaveMode, type AutosaveOptions, type RetainedDraft } from './autosave';
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
  /**
   * Whether this page saves its draft after each edit (g-069).
   *
   * `'autosave'` when the page owns the write and `'explicit'` when it draws a
   * Save button. The default is `'explicit'`: a naked store that starts writing
   * on its own would be a surprise for every existing test and embed, while the
   * page the user actually sees opts in.
   */
  autosave?: 'autosave' | 'explicit';
  /**
   * The client-lifetime owner this store's queue lives in, shared with every
   * previous mount of the same page (see {@link acquireAutosave}). When absent,
   * the store keeps a queue to itself that dies with it.
   */
  autosaveOwner?: AutosaveOwner;
}

/**
 * What one page keeps after it is unmounted.
 *
 * Deliberately two plain values, not the page and not the DOM: a draft the Host
 * never received, and the revision it must be applied to — plus a subscriber list
 * so an open page hears about the queue it shares (see {@link AutosaveOwner}).
 */
export interface AutosaveOwner {
  /** The draft a failed write left behind, or `null` once none is unsaved. */
  retained: RetainedDraft<PanelDraft> | null;
  /** Last revision the shared queue observed; the reopen fences against it. */
  revision: number | undefined;
  /**
   * Live queues for this client, so a page created after the previous one was
   * closed shares the queue its returned draft belongs to.
   */
  queue?: Autosave<PanelDraft> | null;
  /** Pages currently showing this client's queue (normally zero or one). */
  pages?: ReadonlySet<PanelStore>;
}

/** Per-client owners, keyed by settings namespace (`dsh-reflex`, `reflex`, …). */
export const autosaveOwners = new Map<string, AutosaveOwner>();

/**
 * Fetch the client-lifetime autosave owner of one settings namespace.
 *
 * Closing the settings dialog unmounts the page; a queue owned by the component
 * would die in that teardown, taking a debounce that had not fired yet — which is
 * the exact loss g-069 sets out to prevent. Keyed by the namespace the page
 * edits, so two different settings sections never share a queue (and a test that
 * wants a virgin client can call {@link forgetAutosave}).
 * @param namespace - the settings namespace the page edits.
 * @returns the owner, created on first use.
 */
export function acquireAutosave(namespace: string): AutosaveOwner {
  const existing = autosaveOwners.get(namespace);
  if (existing !== undefined) return existing;
  const owner: AutosaveOwner = { retained: null, revision: undefined };
  autosaveOwners.set(namespace, owner);
  return owner;
}

/**
 * Drop one namespace's owner, ending that client lifetime.
 *
 * Used by tests and by an embed that tears its client down; a reload of a real
 * browser drops the whole module, so this is also what a reload amounts to.
 * @param namespace - the settings namespace to forget.
 */
export function forgetAutosave(namespace: string): void {
  const owner = autosaveOwners.get(namespace);
  owner?.queue?.forceDispose();
  autosaveOwners.delete(namespace);
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
  /**
   * Autosave's own status line (g-069), drawn beside the header.
   *
   * Distinct from {@link notice}, which names a *user action* ("Host refused
   * this write"). This one describes the queue: what it is doing now, and — in
   * `failed` — why it stopped, so the page can offer the retry.
   */
  autosave: AutosaveState;
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

/** What the autosave queue is doing, as the page renders it. */
export interface AutosaveState {
  /** `idle` = in step; `pending` = waiting for a pause; `saving` = awaiting the Host. */
  phase: 'idle' | 'pending' | 'saving' | 'saved' | 'failed';
  /** Why the last write failed, when `phase` is `failed`. */
  reason: string | null;
  /** Whether a draft a failed write must not lose is being shown. */
  retained: boolean;
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
 * @param stored - the same rows as the document held them before this page's
 *   edits (`PanelState.original`). A row field the page moved, while the
 *   document still holds its pre-edit value, is an unsaved edit and stays on the
 *   row; every other field is the document's (g-069). `undefined` keeps the
 *   page's row values for fields the document has unanswered for, which is the
 *   first seed's rule.
 * @returns the draft to edit.
 */
export function draftFromFormKeepingRows(
  form: FormSnapshotLike,
  previous: readonly ProfileDraft[],
  stored: readonly ProfileDraft[] | undefined = undefined
): PanelDraft {
  const seeded = draftFromForm(form);
  if (previous.length === 0) return seeded;
  return { ...seeded, backend: { ...seeded.backend, profiles: reseedProfileRows(previous, seeded.backend.profiles, stored) } };
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
  /** Whether this page saves after each edit instead of on a Save press. */
  readonly #autosaveMode: boolean;
  /** The client-lifetime holder of the queue and the retained draft. */
  readonly #owner: AutosaveOwner;
  /** The write queue, created on first use and shared across mounts. */
  #queue: Autosave<PanelDraft> | null = null;
  /** Revision a queued write is fenced by, set only while it runs. */
  #revisionForWrite: number | undefined;
  /**
   * The draft a queued write is diffed against, set only while it runs.
   *
   * `null` means "diff against the Host's document" — the explicit page and
   * every direct `save()` caller. A queued autosave sets it to the draft its edit
   * was made on, so the operation list names exactly that edit's paths (g-069).
   */
  #diffBase: PanelDraft | null = null;
  /**
   * The page's draft when a queued write started, if it was newer than the draft
   * that write carried. Re-applied after every re-seed the write triggers, so a
   * slow answer can never land over typing that came after it (g-069).
   */
  #newerDraft: PanelDraft | null = null;
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
    this.#autosaveMode = options.autosave === 'autosave';
    this.#owner = options.autosaveOwner ?? { retained: null, revision: undefined };
    const form = options.form.getSnapshot();
    const seeded = draftFromForm(form);
    // The initial validation runs through `validateDraft` rather than a literal
    // `[]`: an array built here is created in the *caller's* realm, and the client
    // tests evaluate this module inside a VM, where `deepEqual(errors, [])` then
    // fails on the prototype rather than the (empty) content.
    const initial = validateDraft(seeded);
    // A draft a failed write left behind is adopted before the first render, so
    // reopening the dialog shows the edit the Host never received rather than
    // overwriting it with the last value the Host accepted (g-069). It is only
    // adopted while it still describes something the Host does not hold.
    const retained = this.#owner.retained !== null && this.#differsFrom(seeded, this.#owner.retained.draft) ? this.#owner.retained : null;
    const draft = retained === null ? seeded : retained.draft;
    const draftValidation = retained === null ? initial : validateDraft(draft);
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
      draft,
      errors: draftValidation.errors,
      errorValues: draftValidation.values,
      saving: false,
      notice: retained === null ? null : 'autosaveFailed',
      noticeValues: null,
      autosave: retained === null ? { phase: 'idle', reason: null, retained: false } : { phase: 'failed', reason: retained.reason, retained: true },
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
    // The queue is bound to *this* page here, not in the constructor: a page
    // mounted while its client still owns a queue (the dialog was closed and
    // reopened before a write settled) takes that queue over, so the write's
    // outcome lands in the page the user is watching (g-069).
    this.#queueForClient();
    if (this.#autosaveMode) {
      const pages = new Set(this.#owner.pages ?? []);
      pages.add(this);
      this.#owner.pages = pages;
    }
  }

  /**
   * Report one settlement of the client's queue.
   *
   * The queue's own channel (see `QueueListener`): a write started before this
   * page existed still has to show up in the status line the user is looking at.
   * @param accepted - whether the Host took the write.
   * @param reason - why it did not, when it did not.
   */
  settle(accepted: boolean, reason: string | null): void {
    this.adoptSettlement(accepted, reason);
  }

  /** Whether this page saves after each edit instead of on a Save press. */
  get autosave(): boolean {
    return this.#autosaveMode;
  }

  /**
   * Settle whatever the autosave queue is carrying, and report whether the page
   * ended in step with the Host.
   *
   * The one thing the page still needs to await: an edit that must be *recorded*
   * before a follow-up action runs (ticking delegation writes the consent, then
   * the host patch). On a page without autosave there is nothing queued, so this
   * is `true` and the caller does its own `save()`.
   * @returns whether nothing is left unsaved.
   */
  async whenSaved(): Promise<boolean> {
    if (!this.#autosaveMode) return true;
    const queue = this.#queueForClient();
    await queue.drained();
    return queue.failure === null && !this.#differsFrom(this.#state.original, this.#state.draft);
  }

  /**
   * The client's autosave owner, so the page layer can reuse it too.
   * @returns the owner shared by every mount of this settings namespace.
   */
  get autosaveOwner(): AutosaveOwner {
    return this.#owner;
  }

  /**
   * The write queue of this page (created on first use).
   *
   * Created lazily because most callers never autosave — the explicit-save page
   * and every embed that drives the store directly. When the client already owns
   * a live queue, that one is adopted and rebound to this page
   * ({@link Autosave.rebind}).
   * @returns the queue.
   */
  #queueForClient(): Autosave<PanelDraft> {
    const options: AutosaveOptions<PanelDraft> = {
      write: (entry) => this.#writeDraft(entry),
      changed: (base, draft) => this.#differsFrom(base, draft),
      original: () => this.#state.original,
      // What the Host now holds, in the page's own comparable shape: the write
      // re-seeded `original` from it, so that is the baseline later keystrokes are
      // measured against. (The queue must not reuse `original` behind the write's
      // back — see `Autosave`'s `#lastWritten`.)
      rebase: () => this.#seededFromHost(),
      listeners: () => [...(this.#owner.pages ?? [])],
      reason: () => this.#state.error,
      retain: (draft, reason) => this.#retainDraft(draft, reason),
      ...(this.#options.setTimer === undefined ? {} : { setTimer: this.#options.setTimer }),
      ...(this.#options.clearTimer === undefined ? {} : { clearTimer: this.#options.clearTimer })
    };
    const shared = this.#owner.queue;
    if (this.#queue !== null) return this.#queue;
    if (shared !== null && shared !== undefined) {
      shared.rebind(options);
      this.#queue = shared;
    } else {
      this.#queue = new Autosave<PanelDraft>(options);
      this.#owner.queue = this.#queue;
      // A new queue has no write of its own to remember: the Host's document, as
      // this page seeded it, is what it measures "already saved" against until a
      // write replaces it. (Only on creation — re-stating it on every access would
      // erase what a write already established.)
      this.#queue.baseline(this.#state.original);
    }
    return this.#queue;
  }

  /**
   * Whether two drafts describe different settings.
   *
   * The panel's own group comparison — the same measure the dirty badge uses —
   * so "the page shows unsaved changes" and "there is something to write" can
   * never disagree.
   * @param base - the draft to compare against.
   * @param draft - the candidate.
   * @returns whether they differ.
   */
  #differsFrom(base: PanelDraft, draft: PanelDraft): boolean {
    return dirtyGroups(base, draft).length > 0;
  }

  /**
   * File (or forget) a draft that must survive its page.
   * @param draft - the failed draft, or `null` to forget it.
   * @param reason - why the write failed, when a draft is filed.
   */
  /**
   * Reflect a write the client's shared queue finished for a *previous* page.
   *
   * The queue outlives its page, so a write started before the dialog closed can
   * land after it was reopened. The status line belongs to the page the user is
   * looking at, which cannot see the old page's promise — this is its channel.
   * @param accepted - whether the Host took the write.
   * @param reason - why it did not, when it did not.
   */
  adoptSettlement(accepted: boolean, reason: string | null): void {
    if (this.#disposed) return;
    this.#set({
      autosave: accepted
        ? { phase: 'saved', reason: null, retained: false }
        : { phase: 'failed', reason: reason ?? 'unknown error', retained: true }
    });
  }

  #retainDraft(draft: PanelDraft | null, reason?: string): void {
    const why = reason ?? 'unknown error';
    this.#owner.retained = draft === null ? null : { draft, reason: why };
    // Live pages of this client follow the owner: the queue outlives the page
    // that created it, so a failure settled after a dialog was closed and
    // reopened must still reach the open page's status line.
    const current = this.#state.autosave;
    this.#set({
      autosave:
        draft === null
          ? { phase: current.phase === 'failed' ? 'idle' : current.phase, reason: null, retained: false }
          : { phase: 'failed', reason: why, retained: true }
    });
  }

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

  /**
   * Stop this page, keeping the client's queue alive for the next one.
   *
   * The polling timer and the form subscription belong to this mount and go
   * with it. The queue does not: {@link Autosave.dispose} cancels a debounce into
   * an immediate write and lets the write in flight settle, so closing the
   * settings dialog neither loses a pending change nor strands the draft behind
   * a running write (g-069).
   */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    this.#formUnsubscribe?.();
    this.#formUnsubscribe = undefined;
    this.#owner.revision = this.#state.revision;
    if (this.#owner.pages !== undefined) {
      const pages = new Set(this.#owner.pages);
      pages.delete(this);
      this.#owner.pages = pages;
    }
    this.#queue?.dispose();
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
      // The Host's document is folded into the state on every read (g-069), not
      // only while the page is clean. `original` is what the dirty badge, the
      // "the Host already holds this" test and every write's operation list are
      // measured against, and the old `if (!dirty)` gate kept it frozen at the
      // value the page was seeded with for the whole mount whenever a draft
      // stayed dirty — so a field the Host moved in the meantime went unnoticed,
      // and the page could later write its stale value back over it.
      //
      // The user's draft still wins: `#foldReseed` keeps a newer draft (typing
      // behind a running write, a draft kept from a failed write) on top of the
      // seed, and re-seeds the draft from the Host only when nothing is pending.
      // The live snapshot contributes only the facts this page has no other
      // source for (key presence, pool membership) on top of the draft's own
      // groups; the profile rows belong to the settings document and are re-seeded
      // from it by `#foldReseed` (see `#baselineDraft`), never from this answer.
      const seed = draftFromSnapshot(body, this.#state.draft);
      this.#foldReseed(seed, { phase: 'ready', snapshot: body, fetchedAt: this.#now(), error: null });
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
   *
   * On an autosaving page the edit also *queues the write* (g-069): typing is
   * debounced, a selection or a toggle is written at once. The queue itself
   * decides whether the draft is valid and different enough to be worth a
   * request, so no caller has to remember to ask.
   * @param mutate - receives the current draft; returns the next one.
   * @param mode - `immediate` for a decision (the default: a click), `text` for
   *   a keystroke.
   */
  edit(mutate: (draft: PanelDraft) => PanelDraft, mode: AutosaveMode = 'immediate'): void {
    const before = this.#state.draft;
    const draft = this.#followRenamedActivation(before, mutate(before));
    const { errors, values } = validateDraft(draft);
    this.#set({ draft, errors, errorValues: values, notice: null, noticeValues: null });
    this.#autosave(draft, errors, mode, before);
  }

  /**
   * Hand one edited draft to the client's queue.
   *
   * Only on an autosaving page: the explicit-save page writes nothing until its
   * button is pressed, and an embed that never opted in must not start writing
   * because someone called `edit`.
   * @param draft - the draft to save.
   * @param errors - its validation problems (an invalid draft waits).
   * @param mode - how the edit is spaced.
   * @param before - the draft this edit was made on; the write carries only what
   *   changed between the two (g-069).
   */
  #autosave(draft: PanelDraft, errors: readonly string[], mode: AutosaveMode, before: PanelDraft): void {
    if (!this.#autosaveMode) return;
    const entry: AutosaveEntry<PanelDraft> = {
      draft,
      before,
      errors,
      writable: this.#state.writable,
      revision: this.#state.revision,
      decision: mode === 'immediate'
    };
    const queue = this.#queueForClient();
    // What the page holds at the moment of the edit is the newest draft there is;
    // if a write is already running, that running write will re-seed over it, so
    // it is recorded here and re-applied after every re-seed (g-069).
    if (queue.busy && this.#newerDraft === null) this.#newerDraft = draft;
    this.#set({ autosave: { phase: mode === 'text' ? 'pending' : 'saving', reason: null, retained: queue.failure !== null } });
    void queue.submit(entry, mode).then((accepted) => this.#settleAutosave(accepted));
  }

  /**
   * Reflect the queue's outcome in the status line.
   * @param accepted - whether the write the queue attempted was taken.
   */
  #settleAutosave(accepted: boolean): void {
    const failure = this.#queue?.failure ?? null;
    if (failure !== null) {
      this.#set({ autosave: { phase: 'failed', reason: failure, retained: true } });
      return;
    }
    // "Saved" is a claim about the *page*, not about one request: a write can be
    // accepted (`accepted === true`) while the draft on screen still says
    // something the Host does not hold — typing that arrived behind the write
    // that just landed. Reporting `saved` there is the false "已保存" the review
    // found (g-069, att-005), so the status line follows the same comparison the
    // dirty badge uses and never claims more than the Host holds.
    const unchanged = !this.#differsFrom(this.#state.original, this.#state.draft);
    if (unchanged) {
      this.#set({ autosave: { phase: accepted ? 'saved' : 'idle', reason: null, retained: this.#state.autosave.retained } });
      return;
    }
    if (!accepted) {
      this.#set({ autosave: { phase: 'pending', reason: null, retained: this.#state.autosave.retained } });
      return;
    }
    // Something is still unsaved (typing behind the write that just landed, a
    // draft whose own validation refuses it, a read-only document): still
    // waiting, never "saved". A refusal that *did* happen already reported itself
    // as `failed` above with the Host's reason; an invalid draft's problems are
    // listed on the page, and the user's next edit carries them.
    this.#set({ autosave: { phase: 'pending', reason: null, retained: this.#state.autosave.retained } });
  }

  /**
   * Write a draft the Host never received — the page's retry (g-069).
   *
   * Re-uses the exact write path of an edit: validation, the secret rule and the
   * revision fence all run again, so a retry is never a bypass.
   * @returns whether the Host accepted the retry.
   */
  async retryAutosave(): Promise<boolean> {
    const { draft, errors } = this.#state;
    // A retry re-states the unsaved edit only: it is measured from the newest
    // draft the queue knows the Host to hold, so a field the Host moved while the
    // draft waited is left alone instead of being written back to the value the
    // page was seeded with (g-069). The page's own `original` is the fallback
    // before the queue has a baseline of its own.
    const queue = this.#queueForClient();
    const entry: AutosaveEntry<PanelDraft> = {
      draft,
      before: queue.baselineDraft ?? this.#state.original,
      errors,
      writable: this.#state.writable,
      revision: this.#state.revision
    };
    this.#set({ autosave: { phase: 'saving', reason: null, retained: true } });
    const accepted = await queue.retry(entry);
    this.#settleAutosave(accepted);
    return accepted;
  }

  /**
   * Discard the draft a failed write left behind.
   *
   * The escape hatch that keeps "keep a retryable draft" from becoming a trap: a
   * draft the Host keeps refusing (a row whose stored key a rename would drop,
   * say) can be dropped deliberately, which re-seeds the page from the Host.
   */
  discardRetained(): void {
    this.#owner.retained = null;
    this.reset();
    this.#set({ autosave: { phase: 'idle', reason: null, retained: false }, notice: 'discardedDraft' });
  }

  /**
   * The write behind one queued draft.
   *
   * {@link save} is the page's only write path — validation, the rename-secret
   * rule, the diff and the revision fence — so autosave reuses it rather than
   * growing a second one. Two things are specific to a queued write:
   *
   * - It is fenced by **the revision the draft was read at**, not by whatever
   *   revision the page has reached while the draft waited. The state's
   *   `revision` follows the Host on every re-seed, so using it would let a slow
   *   draft apply on top of a newer read.
   * - A page that was closed while the draft waited still writes it; only the
   *   rendering is gone (`#disposed`), and `save` reports without re-rendering.
   * @param entry - the draft to write.
   * @returns whether the Host now holds it.
   */
  async #writeDraft(entry: AutosaveEntry<PanelDraft>): Promise<boolean> {
    // The *entry's* draft is written, not whatever the page holds now: a queued
    // draft and the live one diverge the moment the user types again, and writing
    // the live one would either lose the queued edit or write a newer draft under
    // an older revision's fence (g-069). The live page catches up through the
    // ordinary re-seed when the write lands.
    const live = this.#state.draft;
    // At write time the page's draft either *is* what this write carries (nothing
    // newer is pending) or is the newer draft to protect — see `#autosave`, which
    // records it at the moment the edit is queued, before any answer can move the
    // page. Recomputing it here would mistake the baseline of a chained write for
    // a newer edit (it is by definition older than the pending one).
    this.#revisionForWrite = entry.revision;
    // The paths this write names are the ones between the draft its edit was made
    // on and the draft it carries (g-069) — see `save`'s `base`.
    this.#diffBase = entry.before;
    this.#set({ draft: entry.draft, errors: [...entry.errors] });
    // The page held a *newer* draft than the one just written when the user kept
    // typing while the write ran. `save` re-seeds `draft` from the Host's answer
    // (`refresh` may do it once more after the write), which is older than that
    // edit — so the edit is put back on top instead of the older answer landing
    // over it (g-069). It is restored whether the write was accepted or not: a
    // refusal must not silently roll the page back either.
    const restore = (): void => {
      if (this.#disposed || this.#newerDraft === null) return;
      const validation = validateDraft(this.#newerDraft);
      this.#set({ draft: this.#newerDraft, errors: validation.errors, errorValues: validation.values });
    };
    try {
      return await this.save();
    } finally {
      this.#revisionForWrite = undefined;
      this.#diffBase = null;
      restore();
      // `save` starts a live-metric read on success; that read re-seeds the draft
      // when nothing is dirty, so the restore is repeated after it settles — and
      // only then is the newer draft released.
      void Promise.resolve()
        .then(() => this.#readSettled)
        .then(restore, restore)
        .then(() => {
          // Released only when nothing is queued behind this drain: a chained
          // write is measured against the same newer draft.
          if (!this.#queue?.queued) this.#newerDraft = null;
        });
    }
  }

  /** Resolves once the read `save` started has been folded into the state. */
  #readSettled: Promise<void> = Promise.resolve();

  /**
   * Fold one re-seed into the state, keeping a draft newer than the running write.
   *
   * Every re-seed path goes through here (the write's own, the live-metric read's,
   * the form's notification) so that one rule holds everywhere: an answer that
   * arrived while the user kept typing must not replace what they typed (g-069).
   * @param seeded - the draft the Host's document seeds.
   * @param extra - any additional state the caller is setting with the re-seed.
   */
  #foldReseed(seeded: PanelDraft, extra: Partial<PanelState> = {}): void {
    // A draft adopted from a failed write is an unsaved edit that outranks every
    // answer until it is written or discarded (g-069) — unconditionally, not only
    // when it differs from the seed. A failed write whose *own* baseline was
    // already up to date leaves `seeded` equal to the kept draft, and comparing
    // the two then drops the draft the user still has to retry.
    const kept = this.#owner.retained?.draft ?? null;
    if (kept !== null) {
      const validation = validateDraft(kept);
      this.#set({ ...extra, original: seeded, draft: kept, errors: validation.errors, errorValues: validation.values });
      return;
    }
    // The *baseline* is the document, with the page's own rows folded in only for
    // the fields the document has not answered (an unnamed row, a field the user
    // typed into while the Host still holds the old value). The seed handed in
    // also carries fields the document *has* answered — a row field the Host moved
    // under the page — and recording those as "what the Host holds" is exactly the
    // false-saved defect (g-069, att-005): the page then reads its draft as equal
    // to `original` and reports an edit the Host never received as saved.
    const original = this.#baselineDraft();
    // A draft newer than the running write (typing that arrived while it ran) is
    // kept on top of the baseline while it still says something the baseline does
    // not.
    const newer = this.#newerDraft;
    if (newer !== null && this.#differsFrom(original, newer)) {
      const validation = validateDraft(newer);
      this.#set({ ...extra, original, draft: newer, errors: validation.errors, errorValues: validation.values });
      return;
    }
    // The rows the Host reports facts for (`apiKeyFromProfile` and friends, folded
    // in from the live snapshot) are not authored by this page, so they belong to
    // the baseline as much as to the draft: the stored-key rule reads them off the
    // *saved* row (g-066), and a baseline without them would let a rename that
    // drops a stored key through. (`#withReportedKeyFacts` returns its input
    // unchanged when the facts are already right.)
    const folded = this.#withReportedKeyFacts(original, seeded.backend.profiles);
    // The draft is the seed plus every row the page shows that the seed does not —
    // matched by identity, because a row being named or renamed is the same row on
    // the page and the seed may not know it yet. A blank scratch row authors no
    // Host path, so `#differsFrom` cannot see it and the seed cannot describe it;
    // it must survive the re-seed for the user to name it (g-064).
    const shown = new Set(seeded.backend.profiles.map((row) => row.id));
    const pageOnly = this.#state.draft.backend.profiles.filter((row) => !shown.has(row.id));
    const draft =
      pageOnly.length === 0
        ? seeded
        : { ...seeded, backend: { ...seeded.backend, profiles: [...seeded.backend.profiles, ...pageOnly] } };
    if (this.#differsFrom(folded, draft)) {
      this.#set({ ...extra, original: folded, draft });
      return;
    }
    // Nothing unsaved: one object serves both. The explicit page reads
    // `state.draft === state.original` to know it has nothing to write, and the
    // page's rows (a blank scratch row included) are what belongs on both sides.
    const settled = this.#sameRows(folded, draft);
    this.#set({ ...extra, original: settled, draft: settled });
  }

  /**
   * The baseline, with the draft's rows.
   *
   * The two drafts are equal as far as the Host is concerned (no group differs), so
   * one object can serve both; what the page shows is the draft's rows, which is
   * the one place a blank scratch row lives.
   * @param folded - the baseline.
   * @param draft - the draft.
   * @returns `draft`, carrying the baseline's other groups.
   */
  #sameRows(folded: PanelDraft, draft: PanelDraft): PanelDraft {
    return { ...folded, backend: draft.backend };
  }

  /**
   * The baseline: the Host's document, plus the row fields it has not answered.
   *
   * The document alone is not the whole baseline, because a row the page keeps by
   * identity can carry an unsaved field the document has never been told about —
   * an unnamed row, or a row whose typed value no write has sent yet. Recording
   * only the document would make such a draft look *more* saved than it is; but
   * recording the page's row wholesale is the opposite error, and the one the
   * review found: the seed handed to {@link #foldReseed} already folds the page's
   * rows in, so taking *its* rows as the baseline let a field the Host itself had
   * moved — or the very edit that was waiting — be recorded as "the Host holds
   * this", after which the page read its draft as clean and reported "saved" for a
   * write that never went out (g-069, att-005).
   *
   * So this is the merge `reseedProfileRows` performs, with the page's row as the
   * candidate and the baseline recorded *before* this re-seed as the answer for
   * "what the document held": a row field the page moved while the document still
   * holds its pre-edit value stays on the baseline; every other field is the
   * document's.
   * @returns the baseline draft.
   */
  #baselineDraft(): PanelDraft {
    const form = this.#options.form.getSnapshot();
    // The rows the page shows, and the ones it showed before this re-seed: a row
    // being named keeps its identity, and the seed carries it under its new name.
    // The baseline describes that row as the document had it, so its fields are
    // the document's, not the page's unsaved values.
    const shown = this.#state.draft.backend.profiles;
    const before = this.#state.original.backend.profiles.filter((row) => row.name.trim().length > 0);
    const previous = shown.filter((row) => row.name.trim().length > 0 || before.some((was) => was.id === row.id));
    // `null` before the page has folded its first re-seed in: the document's own
    // seed is the whole truth then, and `reseedProfileRows` keeps each previous
    // row's values (its documented meaning). Afterwards the baseline recorded by
    // the last fold is what the document held before this page's edits, so a row
    // field the document has since answered is not kept.
    const baseline = this.#baselineRows;
    const merged =
      previous.length === 0
        ? draftFromForm(form)
        : baseline === null
          ? draftFromFormKeepingRows(form, previous)
          : draftFromFormKeepingRows(form, previous, baseline);
    return this.#withReportedKeyFacts(merged, previous);
  }

  /**
   * Carry the Host's key facts from the document seed onto a merged draft.
   *
   * `apiKeyPresent`/`apiKeyFromProfile`/… are not authored anywhere: they are
   * folded in from the live snapshot, *matched by profile name*. A baseline built
   * from rows therefore misses them for a row being renamed — and a rename is
   * exactly the edit the stored-key rule inspects (g-066), so the rule must read
   * the same facts the page shows. Position is taken from the document itself.
   * @param merged - a draft whose rows came from the page's baseline.
   * @param previous - the rows on screen, the source of each reported fact.
   * @returns `merged`, with each row's reported facts taken from the page.
   */
  #withReportedKeyFacts(merged: PanelDraft, previous: readonly ProfileDraft[]): PanelDraft {
    // The page's own row is the source when the page holds this profile: a row
    // being renamed is no longer findable by name in the document, but the page's
    // row carries the fact the snapshot gave it.
    const FIELDS = ['apiKeyPresent', 'apiKeyFromProfile', 'apiKeyVariable', 'apiKeySource', 'apiKeyLocked'] as const;
    let changed = false;
    const profiles = merged.backend.profiles.map((row, index) => {
      const reported = previous[index];
      if (reported === undefined) return row;
      if (FIELDS.every((field) => row[field] === reported[field])) return row;
      changed = true;
      return {
        ...row,
        apiKeyPresent: reported.apiKeyPresent,
        apiKeyFromProfile: reported.apiKeyFromProfile,
        apiKeyVariable: reported.apiKeyVariable,
        apiKeySource: reported.apiKeySource,
        apiKeyLocked: reported.apiKeyLocked
      };
    });
    // Unchanged drafts are returned as the same object: the explicit page checks
    // `state.draft === state.original` to know it has nothing unsaved.
    return changed ? { ...merged, backend: { ...merged.backend, profiles } } : merged;
  }

  /**
   * The rows `this.#state.original` held when the current re-seed began.
   *
   * Captured at the top of {@link #foldReseed} so a chained re-seed (a write's
   * own, then the read it starts) measures a row field against the baseline in
   * force before that re-seed, not against the one it just wrote.
   */
  #baselineRows: readonly ProfileDraft[] | null = null;

  /**
   * The Host's document as a draft, in this page's comparable shape.
   *
   * This answers one question — "what does the Host now hold?" — so it is the
   * document and nothing else. It used to re-seed through
   * `draftFromFormKeepingRows`, which keeps the page's rows; that is right for a
   * *re-seed of the page*, but wrong for this baseline: the page's rows can carry
   * fields no write has sent (an unnamed row, a typed list behind a running
   * write), and melting those into the baseline told the queue the Host already
   * held them. The pending draft then matched `#lastWritten`, was dropped as a
   * no-op, and the page reported "saved" for a write that never went out (g-069).
   * @returns the Host's document as this page would seed it.
   */
  #seededFromHost(): PanelDraft {
    return draftFromForm(this.#options.form.getSnapshot());
  }

  /**
   * Re-seed `original` and `draft` from the Host, keeping this page's own rows.
   *
   * The single re-seed the write path uses: `draftFromFormKeepingRows` carries the
   * rows by identity so an unsaved row is not wiped and a row marker stays put,
   * and setting both halves means "the page is in step with the Host", which is
   * what the queue and the dirty badge measure.
   */
  #reseedFromHost(): void {
    if (this.#disposed) return;
    // The rows on screen are folded into the seed, not re-applied by `#foldReseed`:
    // a re-seed must land the document exactly as read (a field the Host changed
    // underneath the page is adopted), while keeping the rows by identity so an
    // unnamed row is not wiped (see `reseedProfileRows`).
    this.#foldReseed(
      draftFromFormKeepingRows(
        this.#options.form.getSnapshot(),
        this.#state.draft.backend.profiles,
        this.#state.original.backend.profiles
      )
    );
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
  editPools(
    mutate: (pools: PanelDraft['routing']['pools']) => PanelDraft['routing']['pools'],
    mode: AutosaveMode = 'immediate'
  ): void {
    this.edit((draft) => ({ ...draft, routing: { ...draft.routing, pools: mutate(draft.routing.pools) } }), mode);
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
    const seeded = draftFromFormKeepingRows(
      this.#options.form.getSnapshot(),
      this.#state.draft.backend.profiles,
      this.#state.original.backend.profiles
    );
    // A pending autosave would otherwise write the draft the user just threw
    // away (g-069): the queue is emptied first, so "discard" means discarded.
    this.#queue?.cancel();
    this.#set({
      draft: seeded,
      original: seeded,
      errors: [],
      errorValues: {},
      notice: null,
      noticeValues: null,
      ...(this.#autosaveMode ? { autosave: { phase: 'idle' as const, reason: null, retained: false } } : {})
    });
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
    const { draft, original } = this.#state;
    // What this write is diffed against. The button and every other caller diff
    // against the Host's document (`original`, "make the Host match this page");
    // a queued autosave diffs against the draft its edit was made on, so the
    // request names exactly the paths that edit touched (g-069). A field the page
    // never touched therefore cannot appear in the operation list — not even a
    // gate's segments or a value the Host moved under the page.
    const base = this.#diffBase ?? original;
    // The button is disabled for a read-only document; refusing here as well keeps
    // every other caller of `save()` (a keyboard shortcut, auto-save) from
    // writing a document the Host said it will not accept.
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
    // The rename rule always reads the Host's document, never a narrower diff
    // base: it is about what a *rename* would destroy on the Host, and a row the
    // page has not touched since its last write is still retired by the same
    // operation list (`retiredProfileNames` compares rows by identity).
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
    const ops = diffDraft(base, draft, this.#options.form.getSnapshot().user);
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
      // Nothing needs writing, which is the state the save was asking for. The
      // autosaving page is not told "saved" for it (g-069: a no-op must not look
      // like a write); the explicit button keeps its existing confirmation. The
      // re-seed keeps a *blank* unnamed row by identity, so it is still there to
      // be named after a clean save.
      this.#reseedFromHost();
      this.#set({ errors: [], errorValues: {}, notice: this.#autosaveMode ? null : 'clean', noticeValues: null });
      return true;
    }
    this.#set({ saving: true, errors: [], errorValues: {}, notice: null, noticeValues: null });
    try {
      const accepted = await this.#options.form.mutate(ops, this.#revisionForWrite);
      if (!accepted) {
        if (!this.#disposed) this.#set({ saving: false, notice: 'confirmRejected', noticeValues: null });
        return false;
      }
      this.#reseedFromHost();
      this.#set({ saving: false, notice: this.#autosaveMode ? null : 'saved', noticeValues: null });
      this.#readSettled = this.refresh().catch(() => undefined);
      return true;
    } catch (error) {
      if (!this.#disposed) this.#set({ saving: false, error: messageOf(error), notice: null, noticeValues: null });
      // Rethrown so the caller learns *why*: the autosave queue keeps the draft
      // and the reason; the page's button only needs `false`.
      if (this.#autosaveMode) throw error;
      return false;
    } finally {
      this.#revisionForWrite = undefined;
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

  /**
   * Fold a Host settings-section change into the state.
   *
   * The Host's document is always recorded as the baseline (`original`) and its
   * status/revision followed, but the *draft* is decided by {@link #foldReseed}'s
   * one rule: a draft kept from a failed write outranks the Host until it is
   * written or discarded, typing newer than a running write stays on top, and
   * only a page with neither takes the Host's document as its own (g-069).
   *
   * Both branches used to be spelled out here, and the clean one re-seeded the
   * draft unconditionally — which dropped a kept draft whenever the Host's
   * document happened to equal it.
   */
  #adoptForm(): void {
    if (this.#disposed) return;
    const form = this.#options.form.getSnapshot();
    // The seed folds the page's rows in by identity (so an unnamed row survives),
    // while a field the Host moved is adopted from the document (g-069).
    this.#foldReseed(draftFromFormKeepingRows(form, this.#state.draft.backend.profiles, this.#state.original.backend.profiles), {
      configStatus: form.status,
      writable: form.writable,
      revision: form.revision
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
