// Type declarations for server/logger.js (remains plain JS).
export const logger: {
  info(module: string, message: string, meta?: Record<string, unknown>): void;
  warn(module: string, message: string, meta?: Record<string, unknown>): void;
  error(module: string, message: string, meta?: Record<string, unknown>): void;
  debug(module: string, message: string, meta?: Record<string, unknown>): void;
};
