export const signingCertificate: { sha256: string; notBefore: string; notAfter: string };
export function validateSigning(manifest: unknown, options?: { allowTest?: boolean }): unknown;
