export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logWarning(context: string, err: unknown): void {
  console.warn(`[WARN] ${context}: ${formatError(err)}`);
}
