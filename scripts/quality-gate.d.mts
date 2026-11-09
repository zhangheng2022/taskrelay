export function verifyJobs(
  jobs: Record<string, { result?: string; outputs?: { verified?: string } }>,
  desktopRequired: boolean,
  codeRequired?: boolean,
): void;
export function verifySarif(document: unknown): void;

export function verifyPlan(
  jobs: Record<string, { result?: string; outputs?: Record<string, string> }>,
): void;
