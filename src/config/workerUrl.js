export const DEFAULT_WORKER_URL = 'https://reader-worker.artemdusan.workers.dev';

export function getWorkerUrl() {
  const envUrl = import.meta.env.VITE_WORKER_URL?.trim();
  return envUrl || DEFAULT_WORKER_URL;
}
