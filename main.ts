// main.ts — trial lifecycle entrypoint for the git forge.
//
// The harness contract (kit RULES / env wire protocol), implemented here:
//   * MAKEFUN_ENV_URL names the trial environment's origin. If it is not
//     set there is no environment to talk to, so exit 1 immediately.
//   * Build the forge with createApp() from ./app.ts and listen on an
//     ephemeral port (listen(0)); the environment owns the fixed ports.
//   * POST {env}/register with a JSON body {"port": N}: the env takes the
//     address the request came from plus N as this process's base URL.
//     200 means registered; 409 means an earlier register already won and
//     is equally final; 400/405 are contract errors and are fatal; any
//     other outcome (including network errors while the env starts) is
//     retried with exponential backoff.
//   * Poll GET {env}/done until it answers {"done": true}; the env
//     answers at once, so poll with the same backoff and never exit early.
//   * Then close the HTTP server and exit 0; any failure exits 1.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  console.error('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with');
  process.exit(1);
}

/** One register/done request gets this long before it counts as failed. */
const REQUEST_DEADLINE_MS = 30_000;
/** Backoff between retries: starts here, doubles, and stops growing here. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function backoffMs(failures: number): number {
  const grown = BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, grown);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timedSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_DEADLINE_MS);
}

/**
 * Announce the bound port to the env, retrying transient failures.
 * Resolves once the env has accepted a registration (ours or the one
 * that beat us to it); throws only on a contract error (400/405).
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const reply = await fetch(envOrigin + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: port }),
        signal: timedSignal(),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = new Error('register answered HTTP ' + reply.status + ': ' + (await reply.text()));
      }
    } catch (err) {
      // A fetch rejection here is a network/timeout problem, not a verdict:
      // fall through and retry after the backoff.
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Block until the env reports the trial finished: GET /done says so. */
async function awaitTrialEnd(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(envOrigin + '/done', { signal: timedSignal() });
      if (reply.ok) {
        const body: unknown = await reply.json();
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // Not reachable or not parseable yet: that is "not done", poll again.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound !== 'object') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  console.log('[entry] listening on port ' + bound.port);
  await announcePort(bound.port);
  console.log('[entry] registered; waiting for the env to say done');
  await awaitTrialEnd();
  server.close();
  console.log('[entry] done');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error('[entry] ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
