// Process entry point: read config, connect the pool, start HTTP and the background
// loops, and shut down cleanly on SIGTERM (what Kubernetes sends when it stops a pod).

import { getConfig } from './config.js';
import { initPool, closePool } from './db.js';
import { createApp } from './app.js';
import { startLoop } from './loop.js';
import { resolveDueRounds } from './modules/offers/offers.services.js';
import { sendDueEmails } from './email/outbox.services.js';

const SHUTDOWN_TIMEOUT_MS = 10_000; // below Kubernetes' default 30 s grace period

const config = getConfig(); // stops here if a variable is missing
initPool(config.database);
const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`listening on port ${config.port}`);
  if (!config.smtp) console.log('no SMTP configured: emails are printed to this log');
  if (config.devMailbox) console.log('DEV_MAILBOX is on: GET /dev/mailbox shows queued emails (local testing only)');
});

// Both loops run in every backend pod. FOR UPDATE SKIP LOCKED in their queries means
// several pods share the work without doing the same round or email twice.
const loops = [
  startLoop('offer rounds', resolveDueRounds, config.workerIntervalMs),
  startLoop('email outbox', sendDueEmails, config.outboxIntervalMs),
];

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  app.locals.shuttingDown = true; // /health now answers 503

  // Fallback: if something hangs, exit anyway before Kubernetes kills the pod.
  setTimeout(() => {
    console.error('shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting connections and wait for in-flight requests and loop runs to finish.
  // Anything unfinished is safe: rounds and emails are in PostgreSQL, so another pod
  // (or this one after restarting) picks them up.
  server.close(async () => {
    await Promise.all(loops.map((loop) => loop.stop()));
    await closePool();
    console.log('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C locally
