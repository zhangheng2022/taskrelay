/** 同一事务内检查定时配置与聊天输入，避免检查后暂停/改需求仍排队。 */
import type { TaskDefinition } from "../../../packages/contracts/src/index";
export function scheduleFence(task: TaskDefinition) {
  if (!task.scheduleTrigger) return { sql: "1=1", values: [] as (string | number)[] };
  return {
    sql: `EXISTS(SELECT 1 FROM task_schedules s JOIN tasks t ON t.id=s.task_id JOIN ai_threads h ON h.id=s.thread_id AND h.closed=0
    WHERE s.task_id=? AND s.version=? AND s.task_version=t.version AND s.ready=1 AND s.state='enabled'
    AND h.active_turn IS NULL AND NOT EXISTS(SELECT 1 FROM conversation_inbox i WHERE i.thread_id=h.id AND i.status IN ('pending','processing'))
    AND ((SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=h.id AND role='user')<=s.confirmed_seq))`,
    values: [task.id, task.scheduleTrigger.version],
  };
}
