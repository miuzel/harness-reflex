# Reflex UI regression investigation — 2026-10-20

## Observed sessions

- `session-3ffdeb23-4326-4ff7-a139-661831a983d4`: the persisted log contains one Reflex decision, in turn 1. Its requested route is virtual `reflex/reflex-1`; its executed route is `openai-codex/gpt-6.1-sol`, effort `medium`. No explicit `model/selection` record exists in that log. Later turns have no Reflex decision records. The live GUI shows that historical turn-1 card and a physical GPT Medium selector. The log alone does not establish what the user intended when initially creating the session.
- `session-a038ed13-fdb4-4d45-a227-09f1f1f9aaf6`: earlier turns contain physical routing decisions. Turn 4 has a virtual `request/header`, no effort audit record, and a `request/context` without `contextWindow`. The live GUI shows `实际: 实际: ...` and no context percentage. Missing historical decision evidence must not be fabricated.

## Contract findings

1. Cordis waterfalls execute outermost-first, and post-`next()` rewrites happen in reverse order. The host model-selection listener overwrites provider/model/effort after awaiting `next()`. A Reflex listener appended after an existing session's selection listener can therefore be overwritten after plugin reload. Registering Reflex as an outer/prepended listener makes the final routing rewrite independent of initial activation order. A read-only reproduction with the actual installed Cordis, agent model-selection listener, and agent scope reproduced the regression after remove/reappend and recovered with `prepend: true`; the historical session does not record the exact time its listener was reloaded.
2. The host session controller restores pending durable model selection first, otherwise the last request header. An implicit default virtual selection is lost after routing writes a physical header unless the original adaptive intent is persisted through the host's model-selection path.
3. Composer actual values must be session-local and corroborated by physical execution metadata, not inferred from the global settings panel's latest decision. User selection and executed request metadata are different facts.
4. A virtual pool does not have an arbitrary one-million-token capacity. Before physical routing, a conservative known capacity may be advertised only when all candidate windows are known; unknown capacity remains unknown. Normal routed requests should use the selected physical model's metadata.

## Display policy

- Fixed physical model + fixed effort: no new adaptive decision and no adaptive composer indicator.
- Fixed physical model + explicitly adaptive effort: adaptive effort remains supported.
- Virtual model: preserve the virtual selection independently of the physical execution header.
- Historical decisions remain attached to their original turns; changing today's selector must not erase genuine history.
- No physical execution evidence: no fabricated actual model, effort, or percentage.

## Deployment boundary

Repository changes and rebuilt tarballs do not update an independently installed profile plugin. Host changes require loading the updated installed module; browser-only refresh cannot do that. A full DSH restart is the most reliable way to load changed host code, but must be performed by the owner or with explicit authorization. Old logs missing an audit record cannot acquire a truthful historical decision merely by restarting.

## Verification status

- `npm run build:all`: passed, including host/client TypeScript builds and the browser bundle.
- `npm run test`: 58 passed, zero failures or skips.
- `npm run test:plugin`: 235 passed, zero failures or skips. Coverage includes actual host model-selection ordering across reload, durable implicit intent, physical fixed-effort transparency, physical adaptive-effort support, session-local composer projection and stale-evidence invalidation, and conservative virtual context metadata.
- Packaging and mutation-control checks are run separately; their execution logs and release report are the authoritative results.

Live GUI observations above are baseline observations of the installed package, not proof that a rebuilt package has been deployed. No running-host installation, reload, or restart was performed. On the old plugin, a toggle can recreate the ordering problem; with the patched prepended listener and a genuine module reload, existing agents use the live listener registry, so a full DSH restart is not inherently required. After updating the installed package, a full restart remains the reliable alternative when module reload behavior is uncertain. For an older session whose implicit virtual intent was already lost, explicitly reselect the virtual model/adaptive effort; do not infer it from the current physical Medium selection.
