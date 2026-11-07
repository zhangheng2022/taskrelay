-- 暂停领取与状态转换同属 D1 写事务；阻止已完成早期读取的旧请求在发布排空后领取。
CREATE TRIGGER release_claim_barrier BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM settings WHERE (key='claimsEnabled' AND value='0') OR (key='maintenance' AND value='1')) THEN RAISE(ABORT,'CLAIM_BUSY') END;
END;
