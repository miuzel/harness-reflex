/**
 * The payload normalizer: the one place a host's stdin vocabulary is mapped onto
 * the fields `HookDecision` reads.
 *
 * Every host speaks `{session_id, tool_name, tool_input, tool_use_id,
 * tool_response}`, which is already the decision's vocabulary, so this
 * function's real job is the handful of places the hosts differ:
 *
 * 1. **Subagent identity.** Claude's `agent_id` is what the closing decision
 *    keys on; a host may spell it `agent_id` or `subagent_id`, so both fold into
 *    `agent_id` with the explicit one winning.
 * 2. **Kimi Code's `hook_event_name`.** Kimi documents the event name both in
 *    argv and inside the payload (`{"hook_event_name": "PreToolUse", ...}`).
 *    Keeping it on the normalized object means an audit line names the event the
 *    host actually fired rather than only our subcommand spelling.
 * 3. **Kimi Code's `turn_id`.** Kimi's `TurnStarted` payload carries `turn_id`.
 *    It is *not* forwarded into the decision (the decision counts turns from its
 *    own ledger; a host counter there would double-count) — it survives only as
 *    pass-through context, exactly like `cwd` or `model`.
 * 4. **Kimi Code's call id.** Kimi names a tool call `tool_call_id`, where Claude
 *    says `tool_use_id`. Both fold onto `tool_use_id`, because that field is the
 *    PreToolUse dedupe key: without it two *different* calls of the same command
 *    would look like a replay and the stagnation count would never advance.
 * 5. **Kimi Code's tool output.** Kimi's PostToolUse/PostToolUseFailure payload
 *    carries the text as a `tool_output` string (the host truncates it to 2000
 *    characters); Claude carries `tool_response`. When only the Kimi spelling is
 *    present it is forwarded under `tool_response`, which
 *    {@link toolResponseText} already reads as a plain string. This matters
 *    because it is what lets the ledger record a prune candidate at all; Kimi
 *    treats PostToolUse as observation-only, so the replacement is still not
 *    applied to the model's context (documented in the package README).
 * 6. **Extra host context** (`cwd`, `model`, `permission_mode`,
 *    `transcript_path`) is passed through untouched. The decision ignores it, but
 *    dropping it would make the audit ledger less useful than the host.
 *
 * The function is deliberately **total and additive**: it never throws and never
 * invents a field, so applying it to a payload that is already in the decision's
 * vocabulary is a no-op. That is what lets {@link runHook} run it for every host
 * without changing any existing behavior — and why the Claude Code fixtures keep
 * asserting byte-identical output after it was introduced.
 *
 * @module hook/payload
 */

/** The fields a normalized payload may carry, in the decision's vocabulary. */
export interface NormalizedHookPayload extends Record<string, unknown> {
  session_id?: string;
}

/** Read one non-empty string field. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read one plain-object field, rejecting arrays and null. */
function obj(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The extra host context worth keeping for the audit ledger. */
const PASS_THROUGH_FIELDS = [
  'turn_id',
  'cwd',
  'model',
  'permission_mode',
  'transcript_path',
  'prompt',
  'hook_event_name',
  'client_type',
  'session_title'
] as const;

/**
 * Convert a host's hook payload into the shape `HookDecision` reads.
 * @param payload - the raw object the host wrote to stdin.
 * @returns the normalized payload; `session_id` is copied only when present, so
 *   the caller keeps its own fail-open decision for a missing session.
 */
export function normalizeHookPayload(payload: Record<string, unknown>): NormalizedHookPayload {
  const normalized: NormalizedHookPayload = {};

  const sessionId = str(payload.session_id);
  if (sessionId) normalized.session_id = sessionId;

  const toolName = str(payload.tool_name);
  if (toolName) normalized.tool_name = toolName;

  const toolInput = obj(payload.tool_input);
  if (toolInput) normalized.tool_input = toolInput;

  // Kimi names the call `tool_call_id`; fold it onto the dedupe key's field.
  const toolUseId = str(payload.tool_use_id) ?? str(payload.tool_call_id);
  if (toolUseId) normalized.tool_use_id = toolUseId;

  if (payload.tool_response !== undefined) {
    normalized.tool_response = payload.tool_response;
  } else {
    // Kimi's `tool_output` is the same text under another name; forward it as a
    // string, the form `toolResponseText` reads without guessing a sub-field.
    const toolOutput = str(payload.tool_output);
    if (toolOutput) normalized.tool_response = toolOutput;
  }

  // Subagent identity, under either spelling, folded to Claude's field name.
  const agentId = str(payload.agent_id) ?? str(payload.subagent_id);
  if (agentId) normalized.agent_id = agentId;

  // A Stop retry guard must survive: without it a blocking Stop hook is retried
  // until the host's own cap, which is a loop rather than an intervention.
  if (payload.stop_hook_active !== undefined) normalized.stop_hook_active = payload.stop_hook_active;
  const lastAssistant = str(payload.last_assistant_message);
  if (lastAssistant) normalized.last_assistant_message = lastAssistant;
  // Kimi's PostToolUseFailure/StopFailure payloads name the failure; accept the
  // common spelling without overwriting a field the host already set.
  const error = str(payload.error);
  if (error) normalized.error = error;

  const source = str(payload.source);
  if (source) normalized.source = source;
  const reason = str(payload.reason);
  if (reason) normalized.reason = reason;

  // Pass the host-only context through rather than dropping it.
  for (const key of PASS_THROUGH_FIELDS) {
    const value = str(payload[key]);
    if (value) normalized[key] = value;
  }

  return normalized;
}
