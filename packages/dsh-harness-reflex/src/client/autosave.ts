/**
 * Saving the draft after the edit that changed it (g-069).
 *
 * The page used to write only on an explicit Save press. The settings dialog is
 * closed by the shell with no interception point a plugin page can reach (the
 * header's X, the overlay, and the document-level Escape all call the shell's
 * own `close`), so anything typed and not saved was lost silently. This module
 * stops depending on that press — and, just as deliberately, stops depending on
 * the shell at all:
 *
 * - **A discrete choice saves at once.** Activating a connection, picking a
 *   model, flipping a switch: the user meant that click to take effect, so
 *   waiting for a pause buys nothing.
 * - **Continuous typing is debounced.** A keystroke is not a decision; writing
 *   once per keystroke would rewrite the settings section dozens of times for
 *   one sentence, so text lands once typing pauses.
 * - **The owner outlives the page.** This is the part a per-component design
 *   cannot do: closing the dialog unmounts the page, and everything living in
 *   the component dies with it — a debounce still counting included. The queue
 *   is therefore created once per client (see `acquireAutosave` in
 *   `./store`) and keeps its pending write, so a change made just before the
 *   dialog closed still reaches the Host.
 * - **A failure keeps a draft worth retrying.** The failed draft stays in the
 *   live store, and survives the page as a {@link RetainedDraft}, so reopening
 *   the panel in the same client lifetime shows the unsaved edit, why it failed,
 *   and a retry — instead of the last value the Host accepted.
 *
 * Three rules decide *whether* a write happens at all. They live here, not in
 * the caller, so no path can bypass them:
 *
 * 1. **Only a valid draft is written.** The existing validator refuses first; an
 *    invalid draft waits — its problems are already listed on the page — and is
 *    retried by the user's next edit or the page's retry.
 * 2. **A no-op is not a write.** A draft equal to the Host's own snapshot is
 *    skipped, so typing a value back to what the Host holds, or a re-seed that
 *    arrives after a successful write, never causes a request.
 * 3. **One write at a time, and never a stale one.** See {@link Autosave}.
 *
 * Nothing here persists a secret. A key typed into a row is a field of the draft
 * written through the Host's settings API — the same `role('secret')` slot the
 * Save button wrote — and no draft is ever copied anywhere else: no
 * `localStorage`, `sessionStorage`, cookie or disk. The retained draft is a
 * plain in-memory object, and {@link Autosave.dispose} forgets it, so a reload
 * (a new client lifetime) starts from the Host.
 *
 * ## Verification status
 *
 * The properties above are covered by deterministic tests only —
 * `client-autosave.test.ts` drives the store and this queue against a
 * hand-cranked clock, and `client-page.test.ts` renders the page through the
 * same fake runtime. **None of this has been observed in a real DSH Web GUI**
 * (`http://127.0.0.1:3080`): no bundle from this branch has been installed into
 * a running profile, so the actual network timing of "the dialog closes and the
 * write still goes out", the shell's Escape/overlay path, and the status line's
 * layout with a long Host error are all unverified by observation. They are
 * argued from the shell's contract (a section receives `{close}` and is
 * unmounted on close, with no interception point) and pinned by tests; they are
 * not confirmed by eye. Treat the GUI behaviour as unmeasured until someone
 * checks it in a scratch profile.
 *
 * @module dsh-reflex/client/autosave
 */

/**
 * Read a failure's message without requiring `instanceof Error`.
 *
 * A rejection can come from another realm (the Host bridge runs its own module
 * instance), where `instanceof Error` is false and `String(error)` would report
 * `Error: <message>` — or, for a plain throw, `[object Object]`. The page says
 * *why* a write failed, so the message is what matters.
 * @param error - whatever was thrown or rejected.
 * @returns its message, or a readable fallback.
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}

/** Delay between the last keystroke and the write that carries it. */
export const TEXT_DEBOUNCE_MS = 600;

/** How an edit is spaced for the queue. */
export type AutosaveMode = 'immediate' | 'text';

/** One edit, as the page hands it to the queue. */
export interface AutosaveEntry<T> {
  /** The draft as the user just left it. */
  draft: T;
  /** Validation problems of `draft`; a non-empty list blocks the write. */
  errors: readonly string[];
  /** Whether the settings document accepts writes at all. */
  writable: boolean;
  /** The revision the draft was read at; the write's fence. */
  revision: number | undefined;
  /**
   * The draft this edit was made on top of — the page's draft immediately
   * *before* the edit.
   *
   * This is what makes one edit's write name only that edit's change (g-069).
   * The writer diffs `before` against `draft`, so a second field that merely
   * happens to sit unsaved in the same draft (a draft kept from a failed write,
   * a value the Host moved under the page) contributes nothing. Measured against
   * the page's *seeded* copy instead, that field rides along in the same
   * operation list — the review's finding against the first cut of this page.
   */
  before: T;
  /**
   * Whether this edit is a decision: it may carry a typing burst that has not
   * paused yet in the same serialized write (see {@link Autosave.submit}).
   */
  decision?: boolean;
}

/** What the queue needs from the page. */
export interface AutosaveOptions<T> {
  /** Validate, diff and write one draft; resolves to whether the Host took it. */
  write: (entry: AutosaveEntry<T>) => Promise<boolean>;
  /**
   * Whether `draft` differs from `base`.
   *
   * `base` is a draft the page held earlier — normally the snapshot a write
   * last carried — so the comparison is between two drafts, never a diff
   * against the Host.
   */
  changed: (base: T, draft: T) => boolean;
  /** The draft the Host's document currently holds, as the page seeded it. */
  original: () => T;
  /**
   * The draft a write carried, turned into a baseline later edits can be
   * measured against (the page re-seeds from the Host, so its own comparable
   * form of "what was just stored" is what belongs here).
   */
  rebase: (written: T) => T;
  /** Why the page's own write path refused, when it refused without throwing. */
  reason?: () => string | null;
  /** Keep (or, with `null`, forget) the draft a failed write must not lose. */
  retain: (draft: T | null, reason?: string) => void;
  /**
   * Every page currently showing this queue, so a write it finishes is reported
   * to whichever one is on screen.
   *
   * The queue outlives its page (that is its point), so the page that started a
   * write may be gone when it lands — a dialog closed mid-write and reopened. The
   * open page cannot see the closed page's promise, so the queue tells them all.
   */
  listeners?: () => readonly QueueListener[];
  /** Debounce seam. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** One page's view of the queue's outcome. */
export interface QueueListener {
  /** Report the settlement of one write. */
  settle(accepted: boolean, reason: string | null): void;
}

/** A draft a failed write left behind, with the reason it is still unsaved. */
export interface RetainedDraft<T> {
  draft: T;
  /** Why the write failed, as the Host or the network reported it. */
  reason: string;
}

/**
 * The write queue behind the page's autosave.
 *
 * ## Serialization and staleness
 *
 * One write is in flight at a time; edits arriving while it runs collapse into
 * one pending draft — the **last** one, because that is the state the user is
 * looking at. When the in-flight write settles, the pending draft is written
 * next, but only if it says something the Host does not already hold: the queue
 * tracks the newest draft it knows the Host to have (`#lastWritten`) and skips a
 * pending draft equal to it. That single rule keeps an older response from
 * overwriting newer input, and it is what makes keystrokes coalesce:
 *
 * - The write's success path re-seeds the page from the Host, which often
 *   settles the queue on exactly that copy; `#lastWritten` recognises it, and no
 *   request is made.
 * - A keystroke that arrives *after* a write landed was built on the draft that
 *   write carried, so it differs from `#lastWritten` only by that keystroke —
 *   which is then coalesced with the rest of the typing instead of being written
 *   on its own (the page's `original` has already moved on by then, which is why
 *   the queue keeps its own record).
 * - A pending draft that *does* differ is the user's newer edit. It is written
 *   after the first, never before it and never concurrently, and it is never
 *   silently dropped.
 *
 * A failed write keeps its draft and does **not** retry by itself: a Host that
 * is refusing writes would otherwise be hammered with the same request. The
 * page's own retry, or the user's next edit, asks again.
 *
 * ## Lifecycle
 *
 * {@link dispose} cancels the debounce and stops arming new ones, but never
 * aborts the write already in flight and never drops the draft waiting behind
 * it: closing the dialog must not cancel a pending change, and a request the
 * Host has already received cannot be recalled anyway. A pending draft that only
 * a timer would have carried is written at once instead, since a closed page has
 * no owner left to wait for a pause. Entries submitted after disposal are
 * accepted for the same reason — the edit was real even if the page is gone.
 */
export class Autosave<T> {
  #options: AutosaveOptions<T>;
  #setTimer: (callback: () => void, ms: number) => unknown;
  #clearTimer: (handle: unknown) => void;
  /** Pending debounce handle. */
  #timer: unknown;
  /** The newest edit waiting behind the in-flight write. */
  #pending: AutosaveEntry<T> | null = null;
  /**
   * The draft the Host is known to hold: the newest of `original()` and the last
   * write's own snapshot.
   *
   * Tracked here rather than read from the page, because the page re-seeds itself
   * from the Host after a successful write — so by the time the next keystroke
   * arrives, `original` has already moved to the *just written* value and the
   * keystroke would look like an unrelated change that could be written now
   * instead of being coalesced into the pending one. `#lastWritten` stays the
   * same object in that case, which keeps the older, still-pending draft
   * comparable and the keystrokes collapsed (g-069).
   */
  #lastWritten: T | null = null;
  /** The write currently awaiting the Host. */
  #inFlight: Promise<boolean> | null = null;
  /** Last failure reason, so the page can say why nothing was written. */
  #failure: string | null = null;
  #disposed = false;

  /**
   * @param options - the write, the change predicate, and the retained-draft sink.
   */
  constructor(options: AutosaveOptions<T>) {
    this.#options = options;
    this.#setTimer = () => undefined;
    this.#clearTimer = () => undefined;
    this.#bind(options);
  }

  /** Point the queue at one page's callbacks (the constructor, or a reopen). */
  #bind(options: AutosaveOptions<T>): void {
    this.#options = options;
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** A write is awaiting the Host right now. */
  get busy(): boolean {
    return this.#inFlight !== null;
  }

  /** An edit is waiting to be written (debouncing, or queued behind a write). */
  get queued(): boolean {
    return this.#pending !== null;
  }

  /** Why the last write did not land, or `null`. */
  get failure(): string | null {
    return this.#failure;
  }

  /**
   * The newest draft this queue knows the Host to hold.
   *
   * What a *retry* is measured against: the unsaved edit is exactly the distance
   * between this and the draft the page carries, so the retry's write re-states
   * that edit and nothing else — never a field the Host has moved past in the
   * meantime (g-069).
   * @returns the baseline, or `null` before the first seed.
   */
  get baselineDraft(): T | null {
    return this.#lastWritten;
  }

  /**
   * Tell the queue what the Host holds right now.
   *
   * Called once per page mount: a fresh page has no write of its own to
   * remember, so the Host's document — as the page seeded it — is the baseline
   * every later edit is measured against.
   * @param draft - the Host's current document, as a draft.
   */
  baseline(draft: T): void {
    this.#lastWritten = draft;
  }

  /**
   * Note one edit.
   *
   * ## Text and decisions in the same draft (g-069)
   *
   * A keystroke and a decision share one draft, so "the decision writes at once"
   * cannot mean "write the page and drop the text still waiting behind it" — that
   * loses a typed edit — nor "send the text first and the decision after", which
   * would put the decision behind a round trip it does not need. The rule is
   * therefore explicit: **a decision flushes any valid local text waiting in the
   * same draft as part of its own write**, and the queue's serialization keeps
   * that one request ordered ahead of anything the user does next. Because the
   * write diffs the pre-edit draft against the post-edit one, it carries exactly
   * the fields the user touched, and nothing else.
   *
   * An **invalid** draft is still not written, by either path: the flush never
   * bypasses validation, and a decision on an invalid draft waits like typing
   * does (the page already lists what is wrong with it).
   * @param entry - the draft, its validation and its revision.
   * @param mode - `immediate` for a decision, `text` for typing.
   * @returns settles when this change has been written or given up on; never rejects.
   */
  submit(entry: AutosaveEntry<T>, mode: AutosaveMode): Promise<boolean> {
    const decision = mode === 'immediate' || entry.decision === true;
    if (!decision) {
      // Typing coalesces: the newer draft replaces the waiting one, but the entry
      // keeps the *oldest* pending `before`, so the eventual write still names
      // every field this burst touched — not only the last keystroke's (g-069).
      const waiting = this.#pending;
      if (waiting !== null) entry = { ...entry, before: waiting.before };
      this.#pending = entry;
      this.#failure = null;
      if (this.#disposed) {
        // The page is gone and no timer will fire: write what was typed.
        this.#cancelTimer();
        return this.#drain();
      }
      this.#arm();
      return Promise.resolve(false);
    }
    // A decision supersedes a typing burst that has not been written yet, and
    // carries it: the queued entry is replaced by one that states both edits,
    // measured from the oldest pending baseline so the burst's fields are kept.
    const waiting = this.#pending;
    if (waiting !== null) entry = { ...entry, before: waiting.before };
    this.#pending = entry;
    this.#failure = null;
    this.#cancelTimer();
    return this.#drain();
  }

  /**
   * Resolve once nothing is queued or in flight.
   *
   * A page that has to act *after* an edit is recorded (the delegation consent,
   * say) awaits this instead of poking the queue's internals. A debounce still
   * counting is reached first — it is an edit the user already made.
   * @returns whether the last write attempted was accepted; `true` when nothing
   *   was written at all.
   */
  async drained(): Promise<boolean> {
    if (this.#timer !== undefined) this.#cancelTimer();
    let accepted = false;
    for (let round = 0; round < 8; round += 1) {
      if (this.#pending === null) {
        accepted = this.#inFlight !== null ? await this.#inFlight : true;
      } else {
        accepted = await this.#drain();
      }
      if (this.#pending === null && this.#inFlight === null) break;
    }
    return accepted;
  }

  /**
   * Write a draft now, ignoring the debounce — the page's retry after a failure.
   * @param entry - the draft to try again.
   * @returns whether the Host accepted it.
   */
  retry(entry: AutosaveEntry<T>): Promise<boolean> {
    return this.submit(entry, 'immediate');
  }

  /**
   * Cancel the debounce; write what a timer would have carried, then stop.
   *
   * The page calls this when it unmounts. It is deliberately **not** terminal:
   * the queue may be adopted by the next page in the same client lifetime (see
   * {@link rebind}), because a write it settled in the meantime must land in the
   * state the user is now looking at.
   */
  dispose(): void {
    this.#disposed = true;
    this.#cancelTimer();
    if (this.#pending !== null) void this.#drain();
  }

  /**
   * Take over the page's callbacks and wake the queue up again.
   *
   * Called by a page that finds this queue still owned by its client (the
   * settings dialog was closed and reopened before the write it left behind
   * settled). Without it, a settle after the previous page unmounted would have
   * written its result into a store nobody renders any more.
   * @param options - the new page's write, predicates and sink.
   */
  rebind(options: AutosaveOptions<T>): void {
    this.#bind(options);
    this.#disposed = false;
    this.#cancelTimer();
    if (this.#pending !== null) void this.#drain();
  }

  /**
   * Drop the queued draft without writing it — the page's Reset.
   *
   * Distinct from {@link dispose}: disposing *flushes* (a closed dialog must not
   * lose a change), while this is the user saying the change should not happen.
   * A write already in flight is not recalled — the Host has it — but nothing
   * queued behind it is sent.
   */
  cancel(): void {
    this.#cancelTimer();
    this.#pending = null;
  }

  /**
   * Forget the retained draft and refuse further writes — the client is over.
   *
   * Distinct from {@link dispose}: this one is final, and is what forgetting a
   * namespace (`forgetAutosaveOwner`) does, so no draft outlives the lifetime
   * that kept it in memory.
   */
  forceDispose(): void {
    this.cancel();
    this.#disposed = true;
    this.#lastWritten = null;
    this.#options.retain(null);
  }

  /** Arm the debounce, replacing any timer already counting. */
  #arm(): void {
    this.#cancelTimer();
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.#drain();
    }, TEXT_DEBOUNCE_MS);
  }

  /** Cancel the debounce, if one is armed. */
  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Write the pending draft, or wait for the in-flight one to settle first.
   * @returns whether the Host accepted the last write attempted.
   */
  #drain(): Promise<boolean> {
    if (this.#inFlight !== null) return this.#inFlight.then(() => this.#drain());
    const entry = this.#pending;
    if (entry === null) return Promise.resolve(false);
    // Rules 1 and 2 — an invalid, read-only or unchanged draft is not a write.
    // It leaves the queue here; the next edit (or the retry) re-states it, so a
    // draft the Host would refuse cannot write itself later behind the user's
    // back.
    if (!entry.writable || entry.errors.length > 0 || !this.#differs(entry.draft)) {
      this.#pending = null;
      return Promise.resolve(false);
    }
    this.#pending = null;
    // The chain, not the single write, is what "in flight" names: a newer draft
    // queued behind this write is part of the same drain, so a caller that awaits
    // the queue waits for *everything* up to its own point. Tracking only the
    // first write stranded the follow-up: the debounce fired while a write was
    // running, returned immediately, and its draft then sat in `#pending` with no
    // one left to send it (g-069).
    const run = this.#write(entry).then(async (accepted) => {
      while (this.#pending !== null) {
        const next = this.#pending;
        this.#pending = null;
        if (!next.writable || next.errors.length > 0 || !this.#differs(next.draft)) continue;
        accepted = await this.#write(next);
      }
      return accepted;
    });
    this.#inFlight = run;
    void run.then((accepted) => {
      if (this.#inFlight === run) this.#inFlight = null;
      const listeners = this.#options.listeners?.() ?? [];
      for (const listener of listeners) listener.settle(accepted, this.#failure);
    });
    return run;
  }

  /**
   * Perform one write and file its outcome.
   * @param entry - the draft to write.
   * @returns whether the Host accepted it.
   */
  async #write(entry: AutosaveEntry<T>): Promise<boolean> {
    try {
      const accepted = await this.#options.write(entry);
      if (!accepted) {
        // A refusal inside the write path (a Host `mutate` that returned false,
        // or the secret rule) leaves the live page holding the draft; it is kept
        // as well, so closing the dialog does not lose it. The page's own message
        // is preferred: `save` reports *why* it refused in `error`, and a bare
        // "refused" would tell the user nothing (g-069).
        this.#failure = this.#options.reason?.() ?? this.#failure ?? 'refused';
        this.#options.retain(entry.draft, this.#failure);
        return false;
      }
      // The snapshot this write carried, digestified — NOT the page's live
      // `original`: the page re-seeds from the Host after the write *and* keeps
      // accepting edits meanwhile, so by the time this line runs `original` may
      // already describe a newer draft that has not been written yet. Taking it
      // here marked that newer draft as saved and dropped it (g-069).
      this.#lastWritten = this.#options.rebase(entry.draft);
      this.#failure = null;
      this.#options.retain(null);
      return true;
    } catch (error) {
      this.#failure = messageOf(error);
      this.#options.retain(entry.draft, this.#failure);
      return false;
    }
  }

  /**
   * Whether this draft says anything the Host does not already hold.
   *
   * One comparison, against the newest draft the queue knows the Host to have
   * (see `#lastWritten`): a group edited back to its seeded value, a re-seed that
   * arrives after a write, and a keystroke built on a draft that was just written
   * are all "no change" by it.
   * @param draft - the candidate draft.
   * @returns whether it must be written.
   */
  #differs(draft: T): boolean {
    const known = this.#lastWritten;
    if (known === null) return true;
    return this.#options.changed(known, draft);
  }
}
