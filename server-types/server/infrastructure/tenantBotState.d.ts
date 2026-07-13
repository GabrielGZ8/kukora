export interface TenantBotStatus {
  enabled: boolean;
  startedAt: string | null;
  lastToggledAt: string | null;
}

export function isEnabled(uid?: string | null): boolean;
export function setEnabled(uid: string | null | undefined, enabled: boolean): TenantBotStatus;
export function getStatus(uid?: string | null): TenantBotStatus;
export function activeUids(): string[];
