/**
 * Keeping a write-only key when a connection is renamed (g-066).
 *
 * ## The hazard
 *
 * A profile's stored key lives at `systemOne.profiles.<name>.apiKey`, and its
 * name is the user's label for the connection — so renaming a row means writing
 * a *different settings path*, not editing one. The key itself never reaches the
 * page (it is a `role('secret')` slot, stripped at the wire boundary), so the
 * page cannot restate it. Two things follow, and both are proved against the
 * Host's own implementation (`dsh-settings` `mutate`):
 *
 * 1. A rename **does not move** the secret. `mutate` applies the ops to the raw
 *    user layer, which still holds the value at the *old* path; the save writes
 *    the new path, then unsets the old subtree whole. The key goes with it.
 * 2. The page cannot learn, after the fact, that it did. The host reports the
 *    **new** path's secret position as `set: false`, so the row renders "no key
 *    configured" and the next decision fails with an auth error — a silent loss.
 *
 * ## What this module decides
 *
 * For every saved row whose name changed, the old subtree must be removed
 * ({@link PanelStore} emits that unset, g-065) and the new one must be written.
 * The secret is safe in exactly one case: the user typed a new key for that row
 * in the same save. Every other case needs a decision, which is what
 * {@link planRenameSecrets} returns:
 *
 * - **`server-move`** — the server can carry the value across. There is no such
 *   API in the settings surface a plugin page is given (a page can only `set`
 *   a path to a value it holds, and it never holds the key), so this outcome is
 *   reserved for a Host that grows one; see {@link SERVER_SIDE_SECRET_MOVE}.
 * - **`reentry`** — the user must retype the key in the renamed row. This is the
 *   safe default, and it is what the page enforces: the save is *blocked* until
 *   the key is present in the draft, with a message naming every row that needs
 *   it.
 *
 * ## Why not "just don't delete the old path"
 *
 * Keeping `systemOne.profiles.<old>` alive would keep the secret, but it also
 * keeps a *ghost connection*: a row with a base URL and a live key that the page
 * cannot show (its value, or even its shape after the name changed) and that the
 * user believes they renamed away. g-065 spent a whole goal removing exactly
 * that. Losing a key loudly is recoverable in one paste; a hidden live
 * credential is not.
 *
 * @module dsh-reflex/client/rename-secrets
 */

import type { PanelDraft, ProfileDraft } from './panel.js';

/**
 * Whether a Host-side "move this secret to another path" operation exists.
 *
 * `false` for every Host this plugin currently ships on. The settings surface a
 * plugin page is handed (`ConfigForm.mutate`) takes `set`/`unset` path ops whose
 * values come from the page, and the page never receives a secret value — so a
 * cross-path move cannot be expressed, and pretending otherwise would be the
 * silent loss this module exists to prevent. A Host that offers one would make
 * this `true` together with a real implementation of the move in
 * {@link PanelStore}; the constant exists so the decision is written down in one
 * place instead of being implied by its absence.
 */
export const SERVER_SIDE_SECRET_MOVE = false;

/** One row that would lose its key unless the user retypes it. */
export interface RenameSecretBlock {
  /** Old name, whose subtree the save retires. */
  from: string;
  /** New name the row is being saved under. */
  to: string;
  /** Why the key cannot be carried across. */
  reason: 'not-restated' | 'joined-occupied-path' | 'swap';
}

/** What the page must do about the write-only keys a save is about to move. */
export interface RenameSecretPlan {
  /** Rows whose key is safe: the user typed a new value in this save. */
  restated: Array<{ from: string; to: string }>;
  /** Rows that would silently lose their key; the save is refused while any remain. */
  blocked: RenameSecretBlock[];
  /**
   * Whether the Host could move the values itself.
   *
   * Always {@link SERVER_SIDE_SECRET_MOVE} today; carried on the plan so the
   * store branches on one fact (and a test can pin the branch) rather than on a
   * constant read in two places.
   */
  serverMove: boolean;
}

/**
 * Plan the write-only keys a save must carry across profile renames.
 *
 * Rows are matched by **identity**, never by name (g-062): `id` survives a
 * rename, so "same id, different name" is a rename and nothing else is.
 *
 * Three ways a rename can still surprise a user are kept apart, because the fix
 * differs:
 *
 * - `not-restated`: the ordinary case. Nothing carries the old value.
 * - `joined-occupied-path`: the new name already belongs to *another saved row*
 *   in this save, so the renamed row's `set`s and that row's `set`s land on one
 *   path. Which value wins is decided by document order, and the losing row's
 *   key is destroyed with no field the user touched — a collision, not a rename.
 * - `swap`: two saved rows exchange names. Each old subtree is retired and each
 *   new path is written from the *other* row, so `from`/`to` alone cannot say
 *   whose key survives. Refused for the same reason, with its own message.
 *
 * A row whose key the user retyped (`apiKey` non-empty) or explicitly cleared
 * (`clearKey`) is not blocked: the draft *states* what the new path holds, so
 * nothing is lost silently. A row whose key comes from an **environment
 * variable** (`apiKeyFromProfile === false`) is never blocked either: the
 * variable is named, not stored, and a rename does not touch it.
 *
 * @param original - the saved draft the page was seeded with.
 * @param draft - the edited draft about to be written.
 * @returns the safe restatements and the rows that block the save.
 */
export function planRenameSecrets(original: PanelDraft, draft: PanelDraft): RenameSecretPlan {
  const restated: RenameSecretPlan['restated'] = [];
  const blocked: RenameSecretBlock[] = [];
  const savedNames = new Map<string, ProfileDraft>();
  for (const row of original.backend.profiles) {
    const name = row.name.trim();
    if (name.length > 0) savedNames.set(name, row);
  }
  // Which *saved* rows still answer for each name in the draft. A name claimed
  // by another saved row is the collision this plan refuses.
  const nextByName = new Map<string, ProfileDraft[]>();
  const savedIds = new Set([...savedNames.values()].map((row) => row.id));
  for (const row of draft.backend.profiles) {
    const name = row.name.trim();
    if (name.length === 0) continue;
    nextByName.set(name, [...(nextByName.get(name) ?? []), row]);
  }

  for (const [oldName, was] of savedNames) {
    const now = draft.backend.profiles.find((row) => row.id === was.id);
    // A removed row loses its key by design (that is what removal is); g-065
    // already retires the subtree in the same save.
    if (now === undefined) continue;
    const newName = now.name.trim();
    if (newName.length === 0 || newName === oldName) continue;
    // The draft says what the new path holds, so nothing is silent here. Note
    // that a clear is *not* a loss: the user asked for exactly that.
    if (now.apiKey.trim().length > 0) {
      restated.push({ from: oldName, to: newName });
      continue;
    }
    if (now.clearKey) continue;
    // Only a **literal stored in the document** can be lost. `apiKeyPresent`
    // alone is not enough: a row that names `JEV_API_KEY` is present too, and its
    // key lives in the environment, which a rename does not touch. Blocking that
    // row would make renaming any env-backed connection impossible for no
    // reason, so the *source* is what decides — `apiKeyFromProfile`, the same
    // authoritative fact the row renders its placeholder from.
    if (!was.apiKeyFromProfile) continue;

    const claimants = (nextByName.get(newName) ?? []).filter((row) => savedIds.has(row.id) && row.id !== now.id);
    if (claimants.length > 0) {
      blocked.push({ from: oldName, to: newName, reason: 'joined-occupied-path' });
      continue;
    }
    // A swap: some other saved row moved onto `oldName`. Both directions of the
    // exchange would otherwise be described as a plain rename of a row whose key
    // is not the one that ends up at the new path.
    const swapped = [...savedNames.entries()].some(([otherOld, otherRow]) => {
      if (otherOld === oldName) return false;
      const moved = draft.backend.profiles.find((row) => row.id === otherRow.id);
      return moved !== undefined && moved.name.trim() === oldName;
    });
    if (swapped) {
      blocked.push({ from: oldName, to: newName, reason: 'swap' });
      continue;
    }
    blocked.push({ from: oldName, to: newName, reason: 'not-restated' });
  }
  return { restated, blocked, serverMove: SERVER_SIDE_SECRET_MOVE };
}

/**
 * Whether a row's rename is already answered by a retyped key.
 *
 * The page marks such a row with the same message it shows for any renamed row,
 * so the user knows *why* the key field is asking again — and stops asking as
 * soon as the field holds a value.
 * @param plan - the plan for the save in progress.
 * @param row - the draft row.
 * @param oldName - the name it was saved under.
 * @returns true when this row's key was restated in this save.
 */
export function renameRestated(plan: RenameSecretPlan, row: ProfileDraft, oldName: string): boolean {
  return plan.restated.some((entry) => entry.to === row.name.trim() && entry.from === oldName);
}
