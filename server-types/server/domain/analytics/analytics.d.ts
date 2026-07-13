// Type declarations for server/analytics.js (remains plain JS).
export function percentageChange(prices: number[]): number[];
export function stdDev(values: number[]): number;
export function sharpe(prices: number[]): number | null;
export function sortino(prices: number[]): number | null;
export function calmarRatio(prices: number[]): number | null;
export function valueAtRisk(prices: number[], confidence?: number): number | null;
export function drawdown(prices: number[]): number;
export function correlation(a: number[], b: number[]): number;
export function clean(values: number[]): number[];
export function last<T>(values: T[]): T;
