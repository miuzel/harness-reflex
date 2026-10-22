/**
 * The process-shaped wrapper around {@link runHook}.
 *
 * Everything here exists because the command is spawned per event: install the
 * signal path that fails open, write exactly one JSON object to stdout, and
 * flush it before exiting. The decision itself lives in `run.ts` and stays
 * unit-testable without a process.
 *
 * @module hook/cli
 */
import { runHook } from './run.js';

/**
 * Run the `hook` subcommand and exit.
 *
 * `stdout` receives exactly one JSON object (or nothing when the platform is
 * refused). A termination signal writes `{}` and exits 0 so an interrupted hook
 * is indistinguishable from an allow, never from a veto.
 * @param argv - arguments after `hook`; the first is the event name.
 */
export async function runHookCli(argv: string[]): Promise<void> {
  let finished = false;
  const finish = (payload: string, code: number): void => {
    if (finished) return;
    finished = true;
    if (payload.length === 0) {
      process.exit(code);
      return;
    }
    process.stdout.write(payload, () => process.exit(code));
  };
  const onSignal = (): void => finish('{}\n', 0);
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    const result = await runHook(argv[0]);
    if (result.output === null) finish('', result.code);
    else finish(`${JSON.stringify(result.output)}\n`, result.code);
  } catch (error) {
    // runHook itself never throws, but a broken stdout must still fail open.
    process.stderr.write(`harness-reflex hook: ${(error as Error).message}\n`);
    finish('{}\n', 0);
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}
