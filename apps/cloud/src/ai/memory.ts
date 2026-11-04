import {
  BaseStore,
  type Operation,
  type OperationResults,
  type Item,
} from "@langchain/langgraph-checkpoint";
import { seal, unseal } from "../crypto";

type Row = {
  namespace: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
};
const prefix = (a: string[], b: string[]) => b.every((s, i) => s === a[i]);
function matches(
  value: Record<string, unknown>,
  filter: Record<string, unknown>,
) {
  return Object.entries(filter).every(([k, want]) => {
    const actual = value[k];
    if (want && typeof want === "object" && !Array.isArray(want))
      return Object.entries(want).every(([op, v]) => {
        if (op === "$eq") return JSON.stringify(actual) === JSON.stringify(v);
        if (op === "$ne") return JSON.stringify(actual) !== JSON.stringify(v);
        if (typeof actual !== "number" || typeof v !== "number") return false;
        if (op === "$gt") return actual > v;
        if (op === "$gte") return actual >= v;
        if (op === "$lt") return actual < v;
        if (op === "$lte") return actual <= v;
        throw new Error("MEMORY_FILTER_UNSUPPORTED");
      });
    return JSON.stringify(actual) === JSON.stringify(want);
  });
}
/** Owner is supplied by authenticated server code, never a model or client namespace. */
export class D1MemoryStore extends BaseStore {
  constructor(
    private db: D1Database,
    private owner: string,
    private secret: string,
  ) {
    super();
  }
  private async item(row: Row): Promise<Item> {
    return {
      key: row.key,
      namespace: JSON.parse(row.namespace),
      value: await unseal(
        row.value,
        this.secret,
        `memory:${this.owner}:${row.namespace}:${row.key}`,
      ),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
  async mutation(
    namespace: string[],
    key: string,
    value: Record<string, unknown> | null,
  ) {
    const ns = JSON.stringify(namespace),
      at = new Date().toISOString();
    if (value === null)
      return this.db
        .prepare(
          "DELETE FROM ai_memories WHERE owner=? AND namespace=? AND key=?",
        )
        .bind(this.owner, ns, key);
    return this.db
      .prepare(
        "INSERT INTO ai_memories(owner,namespace,key,value,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .bind(
        this.owner,
        ns,
        key,
        await seal(value, this.secret, `memory:${this.owner}:${ns}:${key}`),
        at,
        at,
      );
  }
  async batch<Op extends Operation[]>(ops: Op): Promise<OperationResults<Op>> {
    const out: unknown[] = [];
    for (const op of ops) {
      if ("namespace" in op && "key" in op) {
        const ns = JSON.stringify(op.namespace);
        if ("value" in op) {
          if (op.index) throw new Error("MEMORY_VECTOR_INDEX_UNSUPPORTED");
          await (await this.mutation(op.namespace, op.key, op.value)).run();
          out.push(undefined);
        } else {
          const row = await this.db
            .prepare(
              "SELECT * FROM ai_memories WHERE owner=? AND namespace=? AND key=?",
            )
            .bind(this.owner, ns, op.key)
            .first<Row>();
          out.push(row ? await this.item(row) : null);
        }
      } else {
        const rows = await this.db
          .prepare(
            "SELECT * FROM ai_memories WHERE owner=? ORDER BY updated_at DESC,key",
          )
          .bind(this.owner)
          .all<Row>();
        if ("namespacePrefix" in op) {
          // No semantic search is advertised. Explicit text matching is done by the caller.
          if (op.query) throw new Error("MEMORY_SEMANTIC_SEARCH_UNSUPPORTED");
          const items = await Promise.all(
            rows.results
              .filter((r) =>
                prefix(JSON.parse(r.namespace), op.namespacePrefix),
              )
              .map((r) => this.item(r)),
          );
          out.push(
            items
              .filter((i) => !op.filter || matches(i.value, op.filter))
              .slice(op.offset ?? 0, (op.offset ?? 0) + (op.limit ?? 10)),
          );
        } else {
          let spaces = [...new Set(rows.results.map((r) => r.namespace))]
            .map((n) => JSON.parse(n) as string[])
            .filter((ns) =>
              (op.matchConditions ?? []).every((c) => {
                const parts =
                  c.matchType === "prefix"
                    ? ns.slice(0, c.path.length)
                    : ns.slice(-c.path.length);
                return (
                  parts.length === c.path.length &&
                  c.path.every((s, i) => s === "*" || s === parts[i])
                );
              }),
            )
            .map((ns) => ns.slice(0, op.maxDepth));
          spaces = [
            ...new Map(spaces.map((s) => [JSON.stringify(s), s])).values(),
          ];
          out.push(spaces.slice(op.offset, op.offset + op.limit));
        }
      }
    }
    return out as OperationResults<Op>;
  }
}
