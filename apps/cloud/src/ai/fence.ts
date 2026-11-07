/** Shared atomic fence for graph checkpoints and retained model results. */
export function graphWriteFence(owner: string, id: string, generation?: number) {
  return {
    sql: `EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.owner=? AND g.id=? AND g.active=1
      ${generation === undefined ? "" : "AND g.generation=?"}
      AND EXISTS(SELECT 1 FROM ai_threads th WHERE th.id=g.parent_thread AND th.user_id=g.owner AND th.closed=0)
      AND (g.parent_turn IS NULL OR EXISTS(SELECT 1 FROM ai_turns t WHERE t.id=g.parent_turn AND t.status IN ('running','done')))
      AND (g.run_id IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.id=g.run_id AND r.user_id=g.owner
        AND r.lease_epoch=g.lease_epoch AND r.lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
        AND r.status IN ('running','waiting_user','verifying') AND r.cancel_requested=0)))`,
    values: [owner, id, ...(generation === undefined ? [] : [generation])],
  };
}
