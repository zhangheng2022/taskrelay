// Short-lived, isolated production smoke identity. Never print a token or model key.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  id = "diagnostic_" + randomUUID().replaceAll("-", ""),
  token = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(token).digest("hex");
async function sql(command) {
  await promisify(execFile)(
    process.execPath,
    [
      path.join(root, "node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "taskrelay",
      "--remote",
      "--command",
      command,
    ],
    { cwd: path.join(root, "apps/web"), windowsHide: true, timeout: 60000 },
  );
}
let modelId;
try {
  await sql(
    `INSERT INTO devices(id,name,token_hash,protocol_version) VALUES('${id}','Temporary self-check','${digest}',1)`,
  );
  const request = async (p, body) => {
    const r = await fetch(
      "https://taskrelay.zhangheng.workers.dev/api/device/user/" + p,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000),
      },
    );
    return {
      status: r.status,
      placement: r.headers.get("cf-placement"),
      data: await r.json(),
    };
  };
  console.log(
    JSON.stringify(
      await request(
        "settings/check" +
          (process.argv.includes("--egress") ? "?egress=1" : ""),
      ),
    ),
  );
  if (process.argv.includes("--probe-existing")) {
    const snapshot = await request("snapshot");
    for (const profile of snapshot.data.models ?? []) {
      if (profile.name.startsWith("diagnostic_")) continue;
      const tested = await request(`models/${profile.id}/test`, {});
      console.log(
        JSON.stringify({
          stage: "existing-model-test",
          placement: tested.placement,
          name: profile.name,
          baseUrl: profile.baseUrl,
          protocol: profile.protocol,
          model: profile.model,
          result: tested.data,
        }),
      );
    }
  }
  const saved = await request("models", {
    name: id,
    baseUrl: "https://api.openai.com/v1/responses",
    protocol: "responses",
    model: "diagnostic-only-no-inference",
    apiKey: "invalid-diagnostic-key",
  });
  modelId = saved.data.id;
  console.log(
    JSON.stringify({
      stage: "save",
      status: saved.status,
      error: saved.data.error ?? null,
      normalized: saved.data.baseUrl ?? null,
    }),
  );
} finally {
  if (typeof modelId === "string" && /^model_[a-z0-9]+$/.test(modelId))
    await sql(
      `DELETE FROM model_profiles WHERE id='${modelId}' AND json_extract(config,'$.name')='${id}'`,
    );
  await sql(`DELETE FROM devices WHERE id='${id}' AND token_hash='${digest}'`);
}
