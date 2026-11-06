import { z } from "zod";

export const UPDATE_ORIGIN = "https://tr.zhangheng.eu.org";
export const UPDATE_PATH = "/api/updates/windows-x64";
export const releaseSchema = z
  .object({
    version: z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sha1: z.string().regex(/^[a-f0-9]{40}$/),
    bytes: z.number().int().positive().max(2_000_000_000),
    notes: z.string().max(4000),
    publishedAt: z.string().datetime(),
  })
  .strict();
export type DesktopRelease = z.infer<typeof releaseSchema>;
export const releaseCatalogSchema = z
  .object({
    latest: releaseSchema.shape.version.nullable(),
    releases: z.array(releaseSchema).max(100),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.releases.map((r) => r.version)).size === c.releases.length &&
      (c.latest === null || c.releases.some((r) => r.version === c.latest)),
    "INVALID_RELEASE_CATALOG",
  );
export function packageName(release: DesktopRelease) {
  return `TaskRelay-${release.version}-full.nupkg`;
}
export function packagePath(release: DesktopRelease) {
  return `${UPDATE_PATH}/${release.version}/${release.sha256}/${packageName(release)}`;
}
export function newerVersion(candidate: string, current: string) {
  const a = releaseSchema.shape.version.parse(candidate).split(".").map(Number);
  const b = releaseSchema.shape.version.parse(current).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export interface DesktopUpdateStatus {
  phase:
    | "unsupported"
    | "idle"
    | "checking"
    | "unpublished"
    | "current"
    | "available"
    | "downloading"
    | "waiting"
    | "installing"
    | "error";
  release: DesktopRelease | null;
  progress: number | null;
  checkedAt: string | null;
  error: string | null;
}
