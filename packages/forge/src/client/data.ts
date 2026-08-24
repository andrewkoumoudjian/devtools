import { startTransition, use, useEffect, useReducer, useSyncExternalStore } from "react";

type Entry<T> = {
  key: string;
  promise: Promise<T>;
  status: "pending" | "ok" | "error";
  value?: T;
  error?: unknown;
  at: number;
};

const cache = new Map<string, Entry<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const MAX_ENTRIES = 400;

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function evict() {
  if (cache.size <= MAX_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.status !== "pending") cache.delete(key);
    if (cache.size <= MAX_ENTRIES * 0.8) break;
  }
}

function start<T>(key: string, fn: () => Promise<T>, prev?: Entry<T>): Entry<T> {
  const entry: Entry<T> = {
    key,
    status: prev?.value !== undefined ? "ok" : "pending",
    value: prev?.value,
    at: Date.now(),
    promise: undefined as unknown as Promise<T>,
  };
  entry.promise = track(fn()).then(
    (value) => {
      if (cache.get(key) === entry) {
        cache.set(key, { ...entry, status: "ok", value, error: undefined, at: Date.now() });
        notify(key);
      }
      return value;
    },
    (error: unknown) => {
      if (cache.get(key) === entry) {
        if (entry.value !== undefined) reportError(error, `refresh ${key.split(":")[0]}`);
        cache.set(key, { ...entry, status: entry.value === undefined ? "error" : "ok", error });
        notify(key);
      }
      throw error;
    },
  );
  cache.delete(key);
  cache.set(key, entry);
  evict();
  return entry;
}

function ensure<T>(key: string, fn: () => Promise<T>, ttl: number): Entry<T> {
  const current = cache.get(key) as Entry<T> | undefined;
  if (!current) return start(key, fn);
  if (current.status !== "pending" && Date.now() - current.at > ttl) return start(key, fn, current);
  return current;
}

export function useData<T>(key: string, fn: () => Promise<T>, ttl = 5_000): T {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const set = listeners.get(key) ?? listeners.set(key, new Set()).get(key)!;
    const listener = () => startTransition(() => force());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(key);
    };
  }, [key]);
  const entry = ensure(key, fn, ttl);
  if (entry.status === "ok") return entry.value as T;
  if (entry.status === "error") throw entry.error;
  return use(entry.promise);
}

export function invalidate(prefix: string) {
  for (const [key, entry] of cache) {
    if (!key.startsWith(prefix) || entry.status === "pending") continue;
    cache.set(key, { ...entry, at: 0 });
    notify(key);
  }
}

let pending = 0;
const pendingListeners = new Set<() => void>();
function setPending(delta: number) {
  pending += delta;
  for (const listener of pendingListeners) listener();
}
export function track<T>(promise: Promise<T>): Promise<T> {
  setPending(1);
  return promise.finally(() => setPending(-1));
}
export function usePending(): boolean {
  return useSyncExternalStore(
    (listener) => {
      pendingListeners.add(listener);
      return () => pendingListeners.delete(listener);
    },
    () => pending > 0,
    () => false,
  );
}

export interface Activity {
  text: string;
  done?: number;
  total?: number;
  percent?: number;
}
const activities = new Map<string, Activity>();
const activityListeners = new Set<() => void>();
let activitySnapshot: Activity | null = null;
export function setActivity(key: string, activity: Activity | null) {
  if (activity) activities.set(key, activity);
  else activities.delete(key);
  activitySnapshot = [...activities.values()].at(-1) ?? null;
  for (const listener of activityListeners) listener();
}
export function useActivity(): Activity | null {
  return useSyncExternalStore(
    (listener) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    () => activitySnapshot,
    () => null,
  );
}

export interface TrayError {
  id: number;
  at: number;
  text: string;
  detail?: string;
  status?: number;
}
const trayErrors: TrayError[] = [];
const trayListeners = new Set<() => void>();
let traySnapshot: TrayError[] = [];
let trayId = 0;
const TRAY_MAX = 6;

export function reportError(err: unknown, context?: string) {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") return;
  const status = (error as { status?: number }).status;
  const text = context ? `${context}: ${error.message}` : error.message;
  const last = trayErrors.at(-1);
  if (last && last.text === text && Date.now() - last.at < 2000) return;
  trayErrors.push({ id: ++trayId, at: Date.now(), text, detail: error.stack?.split("\n").slice(1, 3).join(" "), status });
  while (trayErrors.length > TRAY_MAX) trayErrors.shift();
  traySnapshot = [...trayErrors];
  for (const listener of trayListeners) listener();
}
export function dismissError(id?: number) {
  if (id === undefined) trayErrors.length = 0;
  else {
    const index = trayErrors.findIndex((error) => error.id === id);
    if (index >= 0) trayErrors.splice(index, 1);
  }
  traySnapshot = [...trayErrors];
  for (const listener of trayListeners) listener();
}
export function useErrors(): TrayError[] {
  return useSyncExternalStore(
    (listener) => {
      trayListeners.add(listener);
      return () => trayListeners.delete(listener);
    },
    () => traySnapshot,
    () => traySnapshot,
  );
}
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "unhandled"));
  window.addEventListener("error", (event) => reportError(event.error ?? event.message));
}
