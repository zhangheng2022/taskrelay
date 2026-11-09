/** 构建产物的来源与完整性：构建端记录文件树，发布端验证来源后归档；
 * 恢复以 D1 固定的清单摘要为权威，不依赖仍然存在的 CI 候选，也不重新构建。 */
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, lstat, mkdir, cp, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { github, repository, verifyQuality } from "./release-api.mjs";

const manifestName = "artifact-manifest.json";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function fileTree(root, relative = "") {
  const files = {};
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    if (file === manifestName) continue;
    const stat = await lstat(path.join(root, file));
    if (stat.isSymbolicLink()) throw Error("ARTIFACT_LINK_FORBIDDEN");
    if (stat.isDirectory()) Object.assign(files, await fileTree(root, file));
    else if (stat.isFile())
      files[file] = { bytes: stat.size, sha256: sha256(await readFile(path.join(root, file))) };
    else throw Error("ARTIFACT_FILE_INVALID");
  }
  return files;
}
export async function stamp(kind, root) {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const version = JSON.parse(await readFile("apps/desktop/package.json", "utf8")).version;
  const manifest = {
    schema: 1,
    kind,
    sourceCommit,
    version,
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    files: await fileTree(root),
  };
  if (!manifest.runId || !manifest.runAttempt || manifest.repository !== repository)
    throw Error("ARTIFACT_BUILD_CONTEXT_INVALID");
  await writeFile(path.join(root, manifestName), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
export async function verifyFiles(kind, root, sha) {
  const manifest = JSON.parse(await readFile(path.join(root, manifestName), "utf8"));
  if (
    manifest.schema !== 1 ||
    manifest.kind !== kind ||
    manifest.sourceCommit !== sha ||
    manifest.repository !== repository ||
    !/^\d+$/.test(manifest.runId ?? "") ||
    !/^\d+$/.test(manifest.runAttempt ?? "")
  )
    throw Error("ARTIFACT_MANIFEST_INVALID");
  const actual = await fileTree(root);
  if (!Object.keys(actual).length || JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw Error("ARTIFACT_FILES_MISMATCH");
  if (kind === "windows") {
    const acceptance = JSON.parse(
      await readFile(path.join(root, "out/release-manifest.json"), "utf8"),
    );
    if (
      acceptance.sourceCommit !== sha ||
      acceptance.version !== manifest.version ||
      acceptance.actionsRunId !== manifest.runId ||
      acceptance.actionsRunAttempt !== manifest.runAttempt ||
      acceptance.sourceDirty ||
      !acceptance.installedAsarMatches ||
      acceptance.systemEntry?.runner !== "github-hosted"
    )
      throw Error("ARTIFACT_ACCEPTANCE_MISMATCH");
    for (const name of ["packaged-smoke", "installed-smoke"]) {
      const report = JSON.parse(await readFile(path.join(root, `out/${name}.json`), "utf8"));
      if (
        !report.passed ||
        report.version !== manifest.version ||
        JSON.stringify(report) !== JSON.stringify(acceptance.reports[name])
      )
        throw Error("ARTIFACT_ACCEPTANCE_MISMATCH");
    }
  }
  return manifest;
}
export async function sourceArtifact(id, manifest, qualityRunId, currentRunId) {
  if (!/^\d+$/.test(String(id))) throw Error("ARTIFACT_ID_INVALID");
  const artifact = await github(`/actions/artifacts/${id}`);
  const run = await github(`/actions/runs/${manifest.runId}`);
  const ci = String(manifest.runId) === String(qualityRunId);
  const prefix = ci ? "ci" : "build";
  if (
    !artifact ||
    artifact.expired ||
    String(artifact.workflow_run?.id) !== String(manifest.runId) ||
    artifact.name !== `${prefix}-${manifest.kind}-${manifest.runAttempt}` ||
    !run ||
    run.head_branch !== "master" ||
    run.repository?.full_name !== repository ||
    Number(run.run_attempt) !== Number(manifest.runAttempt)
  )
    throw Error("ARTIFACT_SOURCE_INVALID");
  if (ci) {
    if (
      run.path !== ".github/workflows/ci.yml" ||
      run.event !== "push" ||
      run.head_sha !== manifest.sourceCommit ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    )
      throw Error("ARTIFACT_SOURCE_INVALID");
  } else if (
    String(manifest.runId) !== String(currentRunId) ||
    run.path !== ".github/workflows/release.yml" ||
    run.event !== "workflow_dispatch"
  )
    throw Error("ARTIFACT_SOURCE_INVALID");
  return {
    artifactId: String(id),
    runId: manifest.runId,
    runAttempt: manifest.runAttempt,
    manifestHash: sha256(JSON.stringify(manifest)),
  };
}
export async function assemble() {
  const sha = process.env.RELEASE_SHA;
  const qualityRunId = await verifyQuality(sha);
  const plan = {
    schema: 1,
    sha,
    qualityRunId,
    releaseRunId: process.env.GITHUB_RUN_ID,
    sources: {},
  };
  for (const kind of ["web", "windows"]) {
    const id = process.env[kind === "web" ? "WEB_ARTIFACT_ID" : "WINDOWS_ARTIFACT_ID"];
    if (!id) continue;
    const manifest = await verifyFiles(kind, `artifacts/${kind}`, sha);
    plan.sources[kind] = await sourceArtifact(
      id,
      manifest,
      qualityRunId,
      process.env.GITHUB_RUN_ID,
    );
  }
  if (!Object.keys(plan.sources).length) throw Error("RELEASE_ARTIFACTS_EMPTY");
  await writeFile("artifacts/release-plan.json", JSON.stringify(plan, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      Object.entries(plan.sources)
        .map(
          ([kind, source]) =>
            `- ${kind}：${String(source.runId) === String(qualityRunId) ? "复用主分支产物" : "本次补建"}，run ${source.runId} / attempt ${source.runAttempt} / artifact ${source.artifactId}，来源和文件哈希已核验。`,
        )
        .join("\n") + "\n",
    );
  return plan;
}
export async function verifyBundle(root, sha, expectedHash, required = ["web", "windows"]) {
  const bytes = await readFile(path.join(root, "release-plan.json"));
  if (expectedHash && sha256(bytes) !== expectedHash) throw Error("RESUME_PLAN_CHANGED");
  const plan = JSON.parse(bytes);
  if (plan.schema !== 1 || plan.sha !== sha || !plan.sources) throw Error("RELEASE_PLAN_INVALID");
  for (const kind of required) {
    if (!plan.sources[kind]) throw Error("RELEASE_ARTIFACT_MISSING");
    const manifest = await verifyFiles(kind, path.join(root, kind), sha);
    if (sha256(JSON.stringify(manifest)) !== plan.sources[kind].manifestHash)
      throw Error("RELEASE_SOURCE_CHANGED");
  }
  return { plan, hash: sha256(bytes) };
}
async function stageWindows() {
  const root = "out/candidate-windows";
  await mkdir(root, { recursive: true });
  for (const file of [
    "apps/desktop/out/make/squirrel.windows/x64",
    "out/release-manifest.json",
    "out/desktop-release.json",
    "out/system-entry.json",
    "out/packaged-smoke.json",
    "out/installed-smoke.json",
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(file, path.join(root, file), { recursive: true });
  }
  await stamp("windows", root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "stamp") await stamp(process.argv[3], process.argv[4]);
  else if (process.argv[2] === "stage-windows") await stageWindows();
  else if (process.argv[2] === "assemble") await assemble();
  else throw Error("ARTIFACT_COMMAND_INVALID");
}
