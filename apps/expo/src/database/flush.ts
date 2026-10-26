/**
 * Native: SQLite commits every write transaction to disk before it resolves, so
 * there is nothing to flush. The web build resolves `./flush` to flush.web.ts.
 */
export function flushAdapter(_adapter: unknown): Promise<boolean> {
  return Promise.resolve(true);
}

export function installFlushOnHide(_adapter: unknown): void {
  /* native: no-op */
}
