export function signedFixture(
  version: string,
  digest?: string,
): {
  signed: boolean;
  generatedAt: string;
  signing: {
    schema: number;
    type: string;
    testOnly: boolean;
    certificateSha256: string;
    notBefore: string;
    notAfter: string;
    version: string;
    checkedAt: string;
    packageSha256: string;
    files: {
      role: string;
      sha256: string;
      certificateSha256: string;
      status: string;
      trusted: boolean;
      timestamped: boolean;
      timestampCertificateSha256: string;
    }[];
  };
  artifacts: { file: string; sha256: string; bytes: number }[];
};
