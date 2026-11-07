/** 模型响应密文的 D1 分块布局；调用账本拥有身份，正文和分块可独立清理。
 * 先整体按 ai-call:<id> 加密再分块，索引和全部碎片同事务写入；不截断模型结果。 */
export function packCallCipher(cipher: string) {
  if (cipher.length <= 500_000) return { value: cipher, chunks: [] as string[], token: null };
  const chunks: string[] = [];
  for (let offset = 0; offset < cipher.length; offset += 500_000)
    chunks.push(cipher.slice(offset, offset + 500_000));
  const token = crypto.randomUUID();
  return { value: JSON.stringify({ v: 2, token, parts: chunks.length }), chunks, token };
}
export function unpackCallCipher(
  value: string,
  chunks: { part: number; token: string; value: string }[],
) {
  const marker = JSON.parse(value);
  if (marker.v !== 2) return value;
  const selected = chunks.filter((c) => c.token === marker.token).sort((a, b) => a.part - b.part);
  if (
    !Number.isSafeInteger(marker.parts) ||
    marker.parts < 1 ||
    selected.length !== marker.parts ||
    selected.some((c, i) => c.part !== i)
  )
    throw Error("MODEL_CALL_PAYLOAD_MISSING");
  return selected.map((c) => c.value).join("");
}
export function callResultStatements(
  db: D1Database,
  id: string,
  cipher: string,
  guard: { sql: string; values: (string | number | null)[] },
) {
  const packed = packCallCipher(cipher);
  return [
    db
      .prepare(`INSERT OR IGNORE INTO call_results(id,result) SELECT ?,? WHERE ${guard.sql}`)
      .bind(id, packed.value, ...guard.values),
    ...packed.chunks.map((value, part) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO call_result_chunks(id,token,part,value)
      SELECT id,?,?,? FROM call_results WHERE id=? AND result=?`,
        )
        .bind(packed.token, part, value, id, packed.value),
    ),
  ];
}
