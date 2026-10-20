/**
 * Minimal `react` surface this plugin's client bundle consumes.
 *
 * The browser half is compiled against the *shell's* React, which arrives as a
 * platform seed word rather than as a dependency of this package: the plugin
 * ships no `node_modules` for it and must not add one, or two React copies would
 * meet in one page. Declaring exactly the members used here keeps the plugin
 * honest about that boundary — a new hook is a visible edit — and keeps this
 * compile out of `@types/react`, which the package does not depend on.
 *
 * Shapes are intentionally loose: this is a boundary declaration for one consumer,
 * not a re-implementation of React's types.
 */
declare module 'react' {
  /** Anything React can render; the panel is deliberately untyped beyond this. */
  export type ReactNode = unknown;

  /** Create an element without JSX (the bundle is compiled with `jsx: preserve` off). */
  export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;

  /** Stable callback identity across renders. */
  export function useCallback<T>(callback: T, dependencies: readonly unknown[]): T;

  /** Run an effect after render; the returned cleanup runs on unmount. */
  export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;

  /** Memoize a derived value. */
  export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;

  /** A mutable box that survives re-renders. */
  export function useRef<T>(initial: T): { current: T };

  /** Subscribe to an external store without tearing. */
  export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T;
}
