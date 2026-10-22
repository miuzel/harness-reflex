/**
 * Text helpers shared by the intervention decision core.
 *
 * Everything here is host-agnostic: the unit of work is a string, an estimated
 * token count, or a structural content block. No host message type, no session,
 * no tool-execution type is imported or assumed.
 *
 * @module core/text
 */
import { createHash } from 'node:crypto';

/** One content block as the decision surface sees it: a tag and optional text. */
export interface TextBlockLike {
  readonly type?: string;
  readonly text?: string;
}

/**
 * Bound one text to a character budget, marking the cut.
 * @param text - any text.
 * @param max - maximum characters to keep.
 * @returns the bounded text.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Tokens one text costs, at the ledger's shared four-characters-per-token rate.
 * @param text - any text.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/**
 * Stable short digest of one value, used as a payload or call identity.
 * @param value - the text to digest.
 * @returns sixteen hexadecimal characters.
 */
export function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Concatenate the text blocks of one content list.
 * @param content - message or result content.
 * @returns the text, in block order.
 */
export function textOfContent(content: readonly TextBlockLike[] | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text') {
      parts.push(block.text ?? '');
    }
  }
  return parts.join('\n');
}

/**
 * Whether one content list carries at least one text block.
 * @param content - message or result content.
 * @returns whether there is text to rewrite.
 */
export function hasTextBlock(content: readonly TextBlockLike[] | undefined): boolean {
  if (!content) return false;
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text') return true;
  }
  return false;
}
