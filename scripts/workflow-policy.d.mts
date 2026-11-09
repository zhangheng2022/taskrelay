export const ciGateName: string;
export function changedPaths(base: string, head?: string, pullRequest?: boolean): string[];
export function impact(files: string[] | null): {
  code: boolean;
  desktop: boolean;
  cloud: boolean;
  desktopRelease: boolean;
};
export function checkPlan(files: string[] | null): { code: boolean; desktop: boolean };
export function releaseImpact(
  files: string[],
  requested?: string,
): { cloud: boolean; desktop: boolean };
