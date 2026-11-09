export interface BuildManifest {
  schema: number;
  kind: string;
  sourceCommit: string;
  version: string;
  repository: string;
  runId: string;
  runAttempt: string;
  files: Record<string, { bytes: number; sha256: string }>;
}
export function sha256(bytes: string | Uint8Array): string;
export function fileTree(root: string, relative?: string): Promise<BuildManifest["files"]>;
export function stamp(kind: string, root: string): Promise<BuildManifest>;
export function verifyFiles(
  kind: string,
  root: string,
  sha: string,
  options?: { legacyResume?: boolean },
): Promise<BuildManifest>;
export function sourceArtifact(
  id: string,
  manifest: BuildManifest,
  qualityRunId: number,
  currentRunId: string,
): Promise<{ artifactId: string; runId: string; runAttempt: string; manifestHash: string }>;
export function verifyBundle(
  root: string,
  sha: string,
  expectedHash?: string,
  required?: string[],
): Promise<{ plan: { sources: Record<string, unknown> }; hash: string }>;
