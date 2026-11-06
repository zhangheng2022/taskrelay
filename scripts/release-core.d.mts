export const phases: string[];
export function assertNewDesktopVersion(current: string, published: string): void;
export interface ReleaseRecord {
  phase: string;
  cloud: boolean;
  desktop: boolean;
  [key: string]: unknown;
}
export interface ReleaseIO {
  save(previous: ReleaseRecord, next: ReleaseRecord): Promise<ReleaseRecord>;
  assertOwnership(record: ReleaseRecord): Promise<void>;
  pause(record: ReleaseRecord): Promise<void>;
  drain(record: ReleaseRecord): Promise<void>;
  bookmark(): Promise<string>;
  migrate(record: ReleaseRecord): Promise<void>;
  assertQuiescent(record: ReleaseRecord): Promise<void>;
  deploy(record: ReleaseRecord): Promise<void>;
  deployed(record: ReleaseRecord): Promise<boolean>;
  publish(record: ReleaseRecord): Promise<void>;
  register(record: ReleaseRecord): Promise<void>;
  verifyDownload(record: ReleaseRecord): Promise<void>;
  activate(record: ReleaseRecord): Promise<void>;
  compatibleDevice(record: ReleaseRecord): Promise<boolean>;
  restore(record: ReleaseRecord, ready: boolean): Promise<void>;
}
export function runRelease(io: ReleaseIO, record: ReleaseRecord): Promise<ReleaseRecord>;
export function releaseScope(
  files: string[],
  requested?: string,
): { cloud: boolean; desktop: boolean };
