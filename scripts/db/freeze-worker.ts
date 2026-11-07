/** 离线切换临时入口：替换业务 Worker 后暂停所有请求与 DO 业务 alarm。
 * 保持原 DO 类名和 namespace，仅读写 alarm 时点；源 D1 和对象正文保持不变。
 * 由部署操作者在排空后发布，迁移验证完成后再替换为正常入口；不是运行时兼容层。 */
import { DurableObject } from "cloudflare:workers";
class Frozen extends DurableObject {
  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  async fetch() {
    return new Response("STORAGE_FROZEN", { status: 503 });
  }
}
export class RequestCoordinator extends Frozen {}
export class Scheduler extends Frozen {}
export class AiTurn extends Frozen {}
export class Evidence extends Frozen {}
export class BrowserStateStore extends Frozen {}
export class ModelEgress extends Frozen {}
export class NotificationHub extends Frozen {}
export default {
  fetch() {
    return Response.json({ error: "STORAGE_FROZEN" }, { status: 503 });
  },
  scheduled() {},
};
