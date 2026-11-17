/** 发布签名证据的共同门槛：绑定固定公开证书、同版最终产物及安装结果，PR 测试证书不能发布。 */
import certificate from "../resources/signing/certificate-info.json" with { type: "json" };

export const signingCertificate = certificate;
export function validateSigning(manifest, { allowTest = false, legacyResume = false } = {}) {
  const report = manifest.signing;
  const fail = () => {
    throw Error("RELEASE_SIGNATURE_INVALID");
  };
  if (
    manifest.signed !== true ||
    report?.schema !== 1 ||
    report.type !== "self-signed" ||
    typeof report.testOnly !== "boolean" ||
    (report.testOnly && !allowTest) ||
    (!report.testOnly && report.certificateSha256 !== certificate.sha256) ||
    (!report.testOnly &&
      (report.notBefore !== certificate.notBefore || report.notAfter !== certificate.notAfter)) ||
    !/^[a-f0-9]{64}$/.test(report.certificateSha256) ||
    report.version !== manifest.version
  )
    fail();
  const checked = Date.parse(report.checkedAt),
    generated = Date.parse(manifest.generatedAt);
  const before = Date.parse(report.notBefore),
    after = Date.parse(report.notAfter);
  if (
    ![checked, generated, before, after].every(Number.isFinite) ||
    checked < before ||
    checked >= after ||
    checked > generated ||
    generated - checked > 60 * 60 * 1000
  )
    fail();
  const roles = [
    "setup",
    "packaged-app",
    "package-app",
    "package-stub",
    "package-updater",
    "installed-app",
    "installed-stub",
    "installed-updater",
  ];
  // 只有固定清单恢复可以读取 0.27.0 的历史服务签名证据。
  const serviceArtifact = manifest.artifacts?.find((entry) =>
    entry.file.endsWith("/TaskRelay.Service.Setup.exe"),
  );
  if (serviceArtifact) {
    if (!legacyResume || manifest.version !== "0.27.0") fail();
    roles.push("service-setup", "service-host");
  }
  if (!Array.isArray(report.files) || report.files.length !== roles.length) fail();
  const files = new Map(report.files.map((file) => [file.role, file]));
  for (const role of roles) {
    const file = files.get(role);
    if (
      !file ||
      file.status !== "Valid" ||
      file.trusted !== true ||
      file.timestamped !== true ||
      file.certificateSha256 !== report.certificateSha256 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^[a-f0-9]{64}$/.test(file.timestampCertificateSha256)
    )
      fail();
  }
  const artifacts = manifest.artifacts ?? [];
  if (serviceArtifact) {
    const service = manifest.reports?.service;
    if (
      service?.passed !== true ||
      service.version !== manifest.version ||
      service.session !== 0 ||
      service.account !== "NT SERVICE\\TaskRelayExecutor" ||
      service.setupSha256 !== serviceArtifact.sha256 ||
      files.get("service-setup").sha256 !== serviceArtifact.sha256 ||
      files.get("service-host").sha256 !== service.hostSha256
    )
      fail();
  }
  for (const [suffix, digest] of [
    ["/TaskRelay Setup.exe", files.get("setup").sha256],
    ["/TaskRelay-win32-x64/TaskRelay.exe", files.get("packaged-app").sha256],
    [`/TaskRelay-${manifest.version}-full.nupkg`, report.packageSha256],
  ]) {
    const matches = artifacts.filter((file) => file.file.endsWith(suffix));
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(digest) || matches[0].sha256 !== digest)
      fail();
  }
  for (const [left, right] of [
    ["packaged-app", "package-app"],
    ["package-app", "installed-app"],
    ["package-stub", "installed-stub"],
    ["package-updater", "installed-updater"],
  ]) {
    if (files.get(left).sha256 !== files.get(right).sha256) fail();
  }
  return report;
}
