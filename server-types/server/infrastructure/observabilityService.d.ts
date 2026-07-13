// Type declarations for server/observabilityService.js (remains plain JS).
export function emit(category: string, event: string, data?: Record<string, unknown>, level?: string): void;
export const bus: any;
export const RCA_CATEGORIES: Record<string, unknown>;
export function getDashboard(): any;
export function getRCASummary(): any;
export function getRCALog(limit?: number, category?: string | null): any[];
export function getEvents(category: string, limit?: number): any[];
export function getAllRecentEvents(limit?: number): any[];
export function getExchangeHealth(): any;
