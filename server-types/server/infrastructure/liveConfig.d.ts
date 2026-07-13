// Type declarations for server/liveConfig.js (remains plain JS).
export function get(key: string): any;
export function getAll(): any;
export function setMany(values: Record<string, unknown>, source?: string): any;
export function reset(source?: string): any;
export function isExchangeActive(name: string): boolean;
export const ALL_EXCHANGES: string[];
