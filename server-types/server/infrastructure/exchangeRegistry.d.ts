// Type declarations for server/exchangeRegistry.js (remains plain JS — audit 1.1
// scoped only feeConfig, validation, walletManager, advancedRiskEngine).
export function registerExchange(descriptor: any): void;
export function getExchangeNames(): string[];
export function getEnabledExchangeNames(): string[];
export function getExchange(name: string): any;
export function getAllExchanges(): any[];
export function getTakerFee(name: string): number;
