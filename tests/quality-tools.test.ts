import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qualityToolBytes } from "../scripts/quality-tools.mjs";

const bytes = Buffer.from("pinned official archive fixture");
const platform = {
  url: "https://github.com/example/tool/releases/download/v1/tool.tar.gz",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const token = "test-only-api-token";
const metadata = () => ({
  tag_name: "v1",
  assets: [{ id: 123, name: "tool.tar.gz", browser_download_url: platform.url }],
});
const location = "https://release-assets.githubusercontent.com/official/archive?signature=fixture";

test("质量工具正常下载仍校验固定哈希，损坏的成功响应不尝试备用入口", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(bytes);
  };
  assert.deepEqual(await qualityToolBytes(platform, fetcher, token), bytes);
  await assert.rejects(
    qualityToolBytes({ ...platform, sha256: "0".repeat(64) }, fetcher, token),
    /QUALITY_TOOL_HASH_MISMATCH/,
  );
  assert.equal(calls, 2);
});

for (const transportFailure of [false, true]) {
  test(`质量工具通过同一官方资产恢复下载，跨域不转发令牌：${transportFailure}`, async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const headers = new Headers(init?.headers);
      if (url === platform.url) {
        assert.equal(headers.has("Authorization"), false);
        if (transportFailure) throw Error("fixture transport error");
        return new Response(null, { status: 504 });
      }
      if (url.startsWith("https://api.github.com/")) {
        assert.equal(headers.get("Authorization"), `Bearer ${token}`);
        if (url.endsWith("/tags/v1")) {
          assert.equal(init?.redirect, "error");
          return Response.json(metadata());
        }
        assert.equal(url, "https://api.github.com/repos/example/tool/releases/assets/123");
        assert.equal(init?.redirect, "manual");
        assert.equal(headers.get("Accept"), "application/octet-stream");
        return new Response(null, { status: 302, headers: { location } });
      }
      assert.equal(url, location);
      assert.equal(headers.has("Authorization"), false);
      assert.equal(init?.redirect, "error");
      return new Response(bytes);
    };
    assert.deepEqual(await qualityToolBytes(platform, fetcher, token), bytes);
    assert.equal(urls.length, 4);
  });
}

test("备用资产核对拒绝不同版本、文件名、原始下载地址和无效 ID", async () => {
  for (const change of ["tag", "name", "url", "id", "absent"]) {
    const data = metadata();
    if (change === "tag") data.tag_name = "v2";
    if (change === "name") data.assets[0].name = "another.tar.gz";
    if (change === "url") data.assets[0].browser_download_url += "?different=1";
    if (change === "id") data.assets[0].id = -1;
    if (change === "absent") data.assets = [];
    let calls = 0;
    await assert.rejects(
      qualityToolBytes(platform, async () => {
        calls++;
        return calls === 1 ? new Response(null, { status: 504 }) : Response.json(data);
      }),
      /QUALITY_TOOL_ASSET_MISMATCH/,
    );
    assert.equal(calls, 2);
  }
});

test("备用入口拒绝非官方资产主机、HTTP、凭据和非默认端口", async () => {
  for (const invalid of [
    "https://example.com/file",
    "http://release-assets.githubusercontent.com/file",
    "https://user:password@release-assets.githubusercontent.com/file",
    "https://release-assets.githubusercontent.com:444/file",
  ]) {
    let calls = 0;
    await assert.rejects(
      qualityToolBytes(platform, async () => {
        calls++;
        if (calls === 1) return new Response(null, { status: 504 });
        if (calls === 2) return Response.json(metadata());
        return new Response(null, { status: 302, headers: { location: invalid } });
      }),
      /QUALITY_TOOL_ASSET_HOST_INVALID/,
    );
    assert.equal(calls, 3);
  }
});

test("备用下载同样拒绝错误哈希、失败状态、无资产跳转和失败元数据", async () => {
  for (const failure of ["hash", "download", "redirect", "metadata"]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 504 });
      if (calls === 2)
        return failure === "metadata"
          ? new Response(null, { status: 403 })
          : Response.json(metadata());
      if (calls === 3)
        return failure === "redirect"
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 302, headers: { location } });
      return failure === "download"
        ? new Response(null, { status: 503 })
        : new Response("wrong archive");
    };
    await assert.rejects(
      qualityToolBytes(platform, fetcher),
      new RegExp(
        {
          hash: "QUALITY_TOOL_HASH_MISMATCH",
          download: "QUALITY_TOOL_DOWNLOAD_FAILED",
          redirect: "QUALITY_TOOL_ASSET_REDIRECT_REQUIRED",
          metadata: "QUALITY_TOOL_METADATA_FAILED",
        }[failure]!,
      ),
    );
  }
});

test("非 GitHub 固定下载地址不使用令牌请求备用 API", async () => {
  let calls = 0;
  await assert.rejects(
    qualityToolBytes({ ...platform, url: "https://example.com/file" }, async () => {
      calls++;
      return new Response(null, { status: 504 });
    }),
    /QUALITY_TOOL_SOURCE_INVALID/,
  );
  assert.equal(calls, 1);
});
