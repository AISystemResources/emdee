// SPRINT-035: tiny pub/sub so module-scope caches (storage list cache in
// SupabaseStorage, loadVaultIndex memo in vault.ts) stay in sync without
// importing each other. SupabaseStorage publishes on write/delete;
// subscribers clear their own state.
//
// Module-scope: subscribers register at import time, so the registry is
// shared across all callers within one Vercel function instance. Cold
// starts re-run the module init, re-registering subscribers — no manual
// teardown needed.

type NamespaceInvalidator = (namespace: string) => void;

const subscribers: NamespaceInvalidator[] = [];

export function subscribeNamespaceInvalidate(fn: NamespaceInvalidator): void {
  subscribers.push(fn);
}

export function publishNamespaceInvalidate(namespace: string): void {
  for (const fn of subscribers) {
    try {
      fn(namespace);
    } catch {
      // Subscriber failures must not abort the publish loop or surface
      // as write errors. Caches will time out via TTL anyway.
    }
  }
}
