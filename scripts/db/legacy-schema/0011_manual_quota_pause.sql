-- Manual pause remains active until explicitly cleared. An optional timed
-- pause remains independent, and never overrides the manual pause.
ALTER TABLE members ADD COLUMN daily_quota_paused INTEGER NOT NULL DEFAULT 0 CHECK(daily_quota_paused IN (0,1));

DROP TRIGGER claim_guard;
CREATE TRIGGER claim_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND disabled=0) THEN RAISE(ABORT,'USER_DISABLED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM runs WHERE id<>NEW.id AND status IN ('running','waiting_user','verifying') AND (user_id=NEW.user_id OR device_id=NEW.device_id)) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id)
   AND NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND (daily_quota_paused=1 OR daily_quota_paused_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM accounts WHERE id=json_extract(NEW.task_snapshot,'$.accountId') AND (user_id<>NEW.user_id OR (assigned_device_id IS NOT NULL AND assigned_device_id<>NEW.device_id))) THEN RAISE(ABORT,'ACCOUNT_DEVICE_MISMATCH') END;
END;

DROP TRIGGER claim_carry_guard;
CREATE TRIGGER claim_carry_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
 AND NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND (daily_quota_paused=1 OR daily_quota_paused_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) + COALESCE((SELECT runs FROM quota_carry WHERE user_id=NEW.user_id AND day=NEW.started_day),0) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
END;
