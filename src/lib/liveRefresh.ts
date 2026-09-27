/** Serialize refreshes and coalesce bursts. An older response can never
 * overwrite a newer one; disposal also protects a newly selected job. */
export function createLiveRefresh<T>(load: () => Promise<T>, commit: (data: T) => void) {
  let active = true;
  let running = false;
  let pending = false;

  async function refresh() {
    if (!active) return;
    pending = true;
    if (running) return;
    running = true;
    try {
      while (active && pending) {
        pending = false;
        try {
          const data = await load();
          if (active) commit(data);
        } catch {
          // Retain the last successful snapshot; the next event/poll retries.
        }
      }
    } finally {
      running = false;
    }
  }

  return { refresh, dispose: () => { active = false; } };
}
