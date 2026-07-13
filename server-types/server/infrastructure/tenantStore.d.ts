export const DEFAULT_UID: string;

export interface TenantStore<T> {
  get(uid?: string | null): T;
  set(uid: string | null | undefined, value: T): T;
  reset(uid?: string | null): T;
  has(uid?: string | null): boolean;
  keys(): string[];
  delete(uid?: string | null): boolean;
}

export interface TenantStoreOptions {
  maxTenants?: number;
  /**
   * checkpoint 27 fix (TechnicalDueDiligence Hallazgo 4). If provided, the
   * LRU never evicts a key for which this returns true — it walks forward
   * to the next-oldest unprotected key instead. Lets a caller (e.g.
   * walletManager, keyed by whether the tenant's bot is currently enabled)
   * guarantee an active tenant's in-memory state is never silently
   * recreated from scratch — which previously risked a later periodic
   * persistence flush overwriting the tenant's real Mongo snapshot with a
   * blank one. See tenantStore.js for the full write-up.
   */
  isProtected?: (key: string) => boolean;
}

export function createTenantStore<T>(initFn: () => T, opts?: TenantStoreOptions): TenantStore<T>;
