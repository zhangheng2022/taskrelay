import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test(
  "实际 workerd SQLite DO 加密分块、不可变上传、发布引用和退休墓碑",
  { timeout: 60_000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `
    import {BrowserStateStore} from './apps/cloud/src/browser-state-store';
    export class InspectedState extends BrowserStateStore {
      async inspect(){return Object.fromEntries(await this.ctx.storage.list());}
      async reconcileNow(){await super.alarm();}
    }
    export default {async fetch(request,env){
      const {key,operation,value}=await request.json(),state=env.STATES.getByName(key);
      if(operation==='put'){await state.put(key,new TextEncoder().encode(value).buffer);return Response.json({ok:true});}
      if(operation==='get'){const data=await state.get(key);return Response.json({value:data?new TextDecoder().decode(data):null});}
      if(operation==='alarm'){await state.reconcileNow();return Response.json({ok:true});}
      return Response.json(await state.inspect());
    }};`,
        resolveDir: process.cwd(),
        sourcefile: "state-store-fixture.ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2023",
      external: ["cloudflare:workers", "node:buffer"],
    });
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        workers: [
          {
            name: "state-test",
            modules: true,
            script: bundle.outputFiles[0].text,
            compatibilityDate: "2026-11-03",
            compatibilityFlags: ["nodejs_compat"],
            bindings: { MASTER_KEY: Buffer.alloc(32, 7).toString("base64") },
            durableObjects: { STATES: { className: "InspectedState", useSQLite: true } },
            d1Databases: ["DB"],
          },
        ],
      }),
    );
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("DB");
    await db.exec(
      "CREATE TABLE accounts(state_object_key TEXT,previous_state_object_key TEXT); CREATE TABLE browser_state_candidates(object_key TEXT,retired INTEGER,expires_at TEXT); CREATE TABLE browser_state_retirements(object_key TEXT PRIMARY KEY,retired_at TEXT);",
    );
    const request = async (operation: string, key = "snapshot", value?: string) => {
      const response = await mf.dispatchFetch("https://fixture.test/", {
        method: "POST",
        body: JSON.stringify({ key, operation, value }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<Record<string, unknown>>;
    };
    const payload = JSON.stringify({
      secret: "synthetic-private-token",
      padding: "x".repeat(1_100_000),
    });
    await request("put", "snapshot", payload);
    const stored = await request("inspect");
    assert.equal(stored.parts, 3);
    assert.equal(JSON.stringify(stored).includes("synthetic-private-token"), false);
    assert.equal((await request("get")).value, payload);
    const duplicate = await mf.dispatchFetch("https://fixture.test/", {
      method: "POST",
      body: JSON.stringify({ key: "snapshot", operation: "put", value: "replace" }),
    });
    assert.equal(duplicate.status, 500);
    assert.equal((await request("get")).value, payload);
    await db.prepare("INSERT INTO accounts VALUES(?,NULL)").bind("snapshot").run();
    await request("alarm");
    assert.equal((await request("get")).value, payload);
    await db.prepare("DELETE FROM accounts").run();
    await request("alarm");
    assert.equal((await request("get")).value, null);
    assert.equal(
      (await db.prepare("SELECT object_key FROM browser_state_retirements").first())?.object_key,
      "snapshot",
    );
    await request("put", "pending", "temporary");
    await db
      .prepare("INSERT INTO browser_state_candidates VALUES(?,0,?)")
      .bind("pending", new Date(Date.now() + 60_000).toISOString())
      .run();
    await request("alarm", "pending");
    assert.equal((await request("get", "pending")).value, "temporary");
    await db.prepare("UPDATE browser_state_candidates SET expires_at='2000-01-01'").run();
    await request("alarm", "pending");
    assert.equal((await request("get", "pending")).value, null);
  },
);
