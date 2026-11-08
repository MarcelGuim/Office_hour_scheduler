// Runs `work` every `intervalMs`, never two at once: the next run is scheduled only
// after the previous one finished. Errors are logged and the loop keeps going.
// stop() waits for a run in progress, so shutdown never cuts a transaction in half.

export function startLoop(name, work, intervalMs) {
  let timer;
  let current = null;
  let stopped = false;

  async function run() {
    current = (async () => {
      try {
        await work();
      } catch (err) {
        console.error(`${name} loop failed:`, err.message);
      }
    })();
    await current;
    current = null;
    if (!stopped) timer = setTimeout(run, intervalMs);
  }

  timer = setTimeout(run, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (current) await current;
    },
  };
}
