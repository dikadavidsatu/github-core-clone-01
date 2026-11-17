// main.ts -- process entrypoint for the forge.
//
// The trial harness runs this file as the whole program (`node main.ts`), in
// a pod whose only other occupant is the grading suite. The suite speaks to
// us through the environment origin named by MAKEFUN_ENV_URL, and the
// lifecycle it expects is:
//
//   1. We bring the forge up first. The HTTP app (see app.ts) must already
//      be accepting connections before anything else happens, because the
//      moment the suite learns our port it starts probing /healthz and
//      driving traffic at us.
//   2. We bind port 0 so the kernel picks a free ephemeral port -- never a
//      fixed one, and never 8080, which belongs to the suite itself.
//   3. We announce the chosen port with POST /register and a {"port": n}
//      body. The suite notes the address that request arrived from and
//      dials us back at that address plus this port.
//   4. We then ask GET /done, again and again: it answers {"done": false}
//      while the suite works and {"done": true} once the suite has written
//      its export and needs nothing more from us.
//   5. On "done" we close the listener and leave with exit code 0. Exiting
//      earlier, or dying, would strand the suite mid-trial.
//
// Registration is retried patiently: the suite may still be coming up when
// we first call, and a 409 from /register only means an earlier attempt of
// ours already landed, which is the outcome we wanted anyway.

import type { Server } from 'node:http';

import { createApp } from './app.ts';

/** Pause between two polls of the suite's /done endpoint. */
const DONE_POLL_PAUSE_MS = 300;
/** Pause between two attempts to register with the suite. */
const REGISTER_RETRY_PAUSE_MS = 500;
/** Give up registering after this many attempts and fail the boot. */
const REGISTER_MAX_ATTEMPTS = 600;
/** Longest one call to the suite may hang before we abandon and retry it. */
const SUITE_CALL_TIMEOUT_MS = 10_000;
/** Grace period for the listener to drain before the exit is forced. */
const SHUTDOWN_GRACE_MS = 1_500;

function note(line: string): void {
  process.stderr.write(`[forge] ${line}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The suite's origin, from the one variable the harness promises us. */
function suiteOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: nowhere to register with');
  }
  return raw.replace(/\/+$/, '');
}

/** Bind the forge to a kernel-chosen port and report which one it picked. */
function bindForge(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge listener has no port to announce'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Tell the suite where we listen. Retries through connection failures and
 * unexpected statuses; both 200 (accepted) and 409 (an earlier attempt of
 * ours was accepted first) mean the suite knows our port.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(SUITE_CALL_TIMEOUT_MS),
      });
      await reply.arrayBuffer().catch(() => undefined);
      if (reply.status === 200 || reply.status === 409) return;
      note(`register attempt ${attempt}: suite answered HTTP ${reply.status}, retrying`);
    } catch {
      note(`register attempt ${attempt}: suite unreachable, retrying`);
    }
    await pause(REGISTER_RETRY_PAUSE_MS);
  }
  throw new Error(`no registration after ${REGISTER_MAX_ATTEMPTS} attempts`);
}

/**
 * Ask the suite whether it has finished, until it says so. A failed or
 * garbled answer counts as "not yet": the suite is the only judge of when
 * the trial is over, and a transient hiccup must not end our run.
 */
async function waitForSuite(origin: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(SUITE_CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: unknown = await reply.json().catch(() => null);
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // Not an ending: keep waiting for the suite's word.
    }
    await pause(DONE_POLL_PAUSE_MS);
  }
}

/** Close the listener, then exit 0 whether the drain is prompt or not. */
function shutDown(server: Server): void {
  const force = setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
}

const origin = suiteOrigin();
const forge = createApp();
const port = await bindForge(forge);
note(`listening on ephemeral port ${port}`);
await announcePort(origin, port);
note('registered with the suite; serving until it is done');
await waitForSuite(origin);
note('the suite is done; shutting down');
shutDown(forge);
