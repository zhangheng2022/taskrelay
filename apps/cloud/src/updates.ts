import catalogData from "./desktop-releases.json";
import {
  packageName,
  packagePath,
  releaseCatalogSchema,
  serviceCatalogSchema,
  serviceSetupName,
  servicePackagePath,
  SERVICE_UPDATE_PATH,
  UPDATE_PATH,
} from "../../../packages/contracts/src/updates";

const catalog = releaseCatalogSchema.parse(catalogData);
// 旧静态目录仅供首次初始化；有效 D1 配置为空或损坏时不能悄悄回退旧版本。
export async function loadReleaseCatalog(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='desktopReleaseCatalog'")
    .first<{ value: string }>();
  return row ? releaseCatalogSchema.parse(JSON.parse(row.value)) : catalog;
}
export async function loadServiceCatalog(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='windowsServiceReleaseCatalog'")
    .first<{ value: string }>();
  return serviceCatalogSchema.parse(row ? JSON.parse(row.value) : { latest: null, releases: [] });
}
// Only reviewed, pinned releases from this repository. Never an arbitrary URL proxy.
const repository = "zhangheng2022/taskrelay";
const fail = (status: number) =>
  Response.json(
    { error: "UPDATE_UNAVAILABLE" },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  );

export async function serveUpdate(
  request: Request,
  releases = catalog,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return serveCatalog(request, UPDATE_PATH, releases, packagePath, packageName, fetcher);
}

export function serveServiceUpdate(
  request: Request,
  releases: Awaited<ReturnType<typeof loadServiceCatalog>>,
  fetcher: typeof fetch = fetch,
) {
  return serveCatalog(
    request,
    SERVICE_UPDATE_PATH,
    releases,
    servicePackagePath,
    () => serviceSetupName,
    fetcher,
  );
}

async function serveCatalog<T extends { version: string; bytes: number; sha256: string }>(
  request: Request,
  prefix: string,
  releases: { latest: string | null; releases: T[] },
  assetPath: (release: T) => string,
  assetName: (release: T) => string,
  fetcher: typeof fetch,
) {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method)) return fail(405);
  if (url.search) return fail(400);
  if (url.pathname === `${prefix}/latest.json`) {
    const release = releases.releases.find((r) => r.version === releases.latest) ?? null;
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ release }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const release = releases.releases.find((r) => assetPath(r) === url.pathname);
  if (!release) return fail(404);
  let upstream = `https://github.com/${repository}/releases/download/v${release.version}/${assetName(release)}`;
  try {
    for (let hop = 0; hop < 4; hop++) {
      // Do not forward caller cookies, credentials, headers or query parameters.
      const response = await fetcher(upstream, {
        method: request.method,
        redirect: "manual",
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "TaskRelay-Updates",
        },
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = new URL(response.headers.get("location") ?? "", upstream);
        await response.body?.cancel();
        if (
          target.protocol !== "https:" ||
          target.username ||
          target.password ||
          target.port ||
          !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
            target.hostname,
          )
        )
          return fail(502);
        upstream = target.href;
        continue;
      }
      if (
        response.status !== 200 ||
        Number(response.headers.get("content-length")) !== release.bytes
      ) {
        await response.body?.cancel();
        return fail(502);
      }
      // Stream bytes through CF; never expose Location or buffer the package in memory.
      return new Response(response.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(release.bytes),
          "Content-Disposition": `attachment; filename="${assetName(release)}"`,
          "Cache-Control": "public, max-age=31536000, immutable",
          ETag: `"${release.sha256}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch {
    return fail(502);
  }
  return fail(502);
}
