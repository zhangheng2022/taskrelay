export function assertFloors(
  summary: Record<string, { pct: number; total: number }>,
  floors: Record<string, number>,
  previous?: Record<string, number>,
): void;
export function parseLcov(input: string): Map<string, Map<number, number>>;
export function changedLines(diff: string): Set<number>;
