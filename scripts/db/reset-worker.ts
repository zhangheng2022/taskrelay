/** 用户明确要求全量清空时的临时维护入口：不导出 DO 类、不保留 DO 绑定。
 * 仅与删除类迁移一起部署，返回维护状态；随后正常入口重建空命名空间。
 * 不读取或重置平台密钥，不提供公开清理接口，不能代替保留数据的 freeze-worker。 */
export default {
  fetch() {
    return Response.json({ error: "STORAGE_RESET_MAINTENANCE" }, { status: 503 });
  },
  scheduled() {},
};
