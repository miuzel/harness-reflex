/**
 * The payload normalizer: the one place a host's stdin vocabulary is mapped onto
 * the fields `HookDecision` reads.
 *
 * The two vocabularies overlap almost entirely — the hosts speak
 * `{session_id, tool_name, tool_input, tool_use_id, tool_response}`, which is
 * exactly what the decision layer wants — so this function's real job is the
 * handful of places they differ:
 *
 * 1. **Subagent identity.** Claude's `agent_id` is what the closing decision keys
 *    on; a host may spell it `agent_id` or `subagent_id`, so both fold into
 *    `agent_id` with the explicit one winning.
 * 2. **Extra host context** (`turn_id`, `cwd`, `model`, `permission_mode`,
 *    `transcript_path`) is passed through untouched. The decision ignores it, but
 *    dropping it would make the audit ledger less useful than the host.
 * 3. **Tool result shape.** A host may send `tool_response` as an object with
 *    `content`/`output`; the decision's `toolResponseText` already understands
 *    those, so the value is forwarded as-is rather than flattened here.
 *
 * `argv` is never consulted. Codex does not forward handler `args` (measured: a
 * handler declared with `args: ["session-start"]` runs with `argv = []`), so
 * trusting it would silently lose the event; the payload is the authority.
 *
 * The function is deliberately **total and additive**: it never throws and never
 * invents a field, so applying it to a payload that is already in the decision's
 * vocabulary is a no-op. That is what lets {@link runHook} run it for every host
 * without changing any existing behavior.
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
  'hook_event_name'
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

  const toolUseId = str(payload.tool_use_id);
  if (toolUseId) normalized.tool_use_id = toolUseId;

  if (payload.tool_response !== undefined) normalized.tool_response = payload.tool_response;

  // Subagent identity, under either spelling, folded to Claude's field name.
  const agentId = str(payload.agent_id) ?? str(payload.subagent_id);
  if (agentId) normalized.agent_id = agentId;

  // A Stop retry guard must survive: without it a blocking Stop hook is retried
  // until the host's own cap, which the Codex probe measured as unbounded.
  if (payload.stop_hook_active !== undefined) normalized.stop_hook_active = payload.stop_hook_active;
  const lastAssistant = str(payload.last_assistant_message);
  if (lastAssistant) normalized.last_assistant_message = lastAssistant;

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
