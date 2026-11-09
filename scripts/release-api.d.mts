export const repository: string;
export const account: string;
export const database: string;
export const dbPath: string;
export const productionOrigin: string;
export function productionHealth(): Promise<{
  service: "TaskRelay";
  protocolVersion: number;
  sourceCommit?: string | null;
}>;
export function github(route: string, method?: string, body?: unknown): Promise<any>;
export function cloudflare(route: string, method?: string, body?: unknown): Promise<any>;
export function query(sql: string, params?: unknown[]): Promise<any[]>;
export function verifyQuality(sha: string, legacy?: boolean): Promise<number>;
