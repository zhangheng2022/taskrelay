// 发布测试的合成签名证据；不代表真实 Authenticode 验证结果。
import { signingCertificate } from "../scripts/signing-policy.mjs";
export function signedFixture(version, digest = "a".repeat(64)) {
  const generatedAt = new Date().toISOString();
  return {
    signed: true,
    generatedAt,
    signing: {
      schema: 1,
      type: "self-signed",
      testOnly: false,
      certificateSha256: signingCertificate.sha256,
      notBefore: signingCertificate.notBefore,
      notAfter: signingCertificate.notAfter,
      version,
      checkedAt: generatedAt,
      packageSha256: digest,
      files: [
        "setup",
        "packaged-app",
        "package-app",
        "package-stub",
        "package-updater",
        "installed-app",
        "installed-stub",
        "installed-updater",
      ].map((role) => ({
        role,
        sha256: digest,
        certificateSha256: signingCertificate.sha256,
        status: "Valid",
        trusted: true,
        timestamped: true,
        timestampCertificateSha256: "b".repeat(64),
      })),
    },
    artifacts: [
      `apps/desktop/out/make/squirrel.windows/x64/TaskRelay-${version}-full.nupkg`,
      "apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe",
      "apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe",
    ].map((file) => ({ file, sha256: digest, bytes: 16 })),
  };
}
