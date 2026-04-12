const DEFAULT_ACTIVITY = {
  phase: "idle",
  progress: null,
  result: null,
  startedAt: null,
  finishedAt: null,
};

let activity = DEFAULT_ACTIVITY;
const listeners = new Set();

function emit() {
  for (const listener of listeners) {
    listener(activity);
  }
}

export function getSyncActivity() {
  return activity;
}

export function subscribeSyncActivity(listener) {
  listeners.add(listener);
  listener(activity);
  return () => listeners.delete(listener);
}

export function resetSyncActivity() {
  activity = DEFAULT_ACTIVITY;
  emit();
}

export function startSyncActivity() {
  activity = {
    phase: "syncing",
    progress: { done: 0, total: 0 },
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  emit();
}

export function updateSyncActivity(done, total) {
  activity = {
    ...activity,
    phase: "syncing",
    progress: { done, total },
  };
  emit();
}

export function finishSyncActivity(result) {
  activity = {
    phase: result?.error ? "error" : "success",
    progress: null,
    result,
    startedAt: null,
    finishedAt: Date.now(),
  };
  emit();
}
