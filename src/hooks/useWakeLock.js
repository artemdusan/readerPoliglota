import { useEffect, useRef } from "react";

async function releaseWakeLock(sentinel) {
  if (!sentinel) return;
  try {
    await sentinel.release();
  } catch {
    // Ignore release races from browsers that auto-release wake locks.
  }
}

export function useWakeLock(active) {
  const sentinelRef = useRef(null);

  useEffect(() => {
    if (!active) {
      void releaseWakeLock(sentinelRef.current);
      sentinelRef.current = null;
      return undefined;
    }

    if (
      typeof window === "undefined" ||
      typeof document === "undefined" ||
      !("wakeLock" in navigator)
    ) {
      return undefined;
    }

    let cancelled = false;

    async function requestWakeLock() {
      if (cancelled || document.visibilityState === "hidden") return;
      if (sentinelRef.current && !sentinelRef.current.released) return;

      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await releaseWakeLock(sentinel);
          return;
        }

        sentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (sentinelRef.current === sentinel) {
            sentinelRef.current = null;
          }
        });
      } catch (error) {
        console.warn("[WakeLock] request failed:", error?.message || error);
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    }

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      void releaseWakeLock(sentinel);
    };
  }, [active]);
}

export default useWakeLock;
