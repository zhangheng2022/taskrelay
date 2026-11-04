-- Keep all legacy IDs and encryption contexts. The verified OWNER_EMAIL claims this identity.
CREATE TABLE members (
 id TEXT PRIMARY KEY, auth_id TEXT UNIQUE, email TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 disabled INTEGER NOT NULL DEFAULT 0, last_claim_at TEXT,
 daily_runs INTEGER NOT NULL DEFAULT 5, scheduled_tasks INTEGER NOT NULL DEFAULT 3,
 queued_runs INTEGER NOT NULL DEFAULT 5, daily_chat INTEGER NOT NULL DEFAULT 50,
 daily_models INTEGER NOT NULL DEFAULT 200
);
INSERT INTO members(id,role) VALUES('legacy_owner','admin');
-- D1 keeps foreign_keys enabled: ADD COLUMN cannot combine REFERENCES with a
-- non-NULL default on populated tables. Preserve rows/IDs with owner guards.
ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_owner';
ALTER TABLE accounts ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_owner';
ALTER TABLE accounts ADD COLUMN assigned_device_id TEXT REFERENCES devices(id);
ALTER TABLE accounts ADD COLUMN profile_id TEXT;
ALTER TABLE accounts ADD COLUMN login_reset INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET profile_id=id;
UPDATE accounts SET assigned_device_id=(SELECT device_id FROM runs WHERE account_key=accounts.id AND device_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1);
ALTER TABLE runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_owner';
ALTER TABLE runs ADD COLUMN profile_id TEXT;
ALTER TABLE runs ADD COLUMN started_day TEXT;
UPDATE runs SET profile_id=COALESCE(json_extract(task_snapshot,'$.accountId'),'task_'||task_id);
ALTER TABLE model_usage ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_owner';
CREATE TRIGGER tasks_owner_insert BEFORE INSERT ON tasks WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER tasks_owner_update BEFORE UPDATE OF user_id ON tasks WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER accounts_owner_insert BEFORE INSERT ON accounts WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER accounts_owner_update BEFORE UPDATE OF user_id ON accounts WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER runs_owner_insert BEFORE INSERT ON runs WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER runs_owner_update BEFORE UPDATE OF user_id ON runs WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER usage_owner_insert BEFORE INSERT ON model_usage WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER usage_owner_update BEFORE UPDATE OF user_id ON model_usage WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'USER_NOT_FOUND'); END;
CREATE TRIGGER member_owner_delete BEFORE DELETE ON members WHEN EXISTS(SELECT 1 FROM tasks WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM accounts WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM runs WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM model_usage WHERE user_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'USER_HAS_DATA'); END;
CREATE TRIGGER member_owner_rename BEFORE UPDATE OF id ON members WHEN NEW.id<>OLD.id AND (EXISTS(SELECT 1 FROM tasks WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM accounts WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM runs WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM model_usage WHERE user_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'USER_HAS_DATA'); END;
CREATE INDEX tasks_owner ON tasks(user_id,status);
CREATE INDEX runs_owner_queue ON runs(user_id,status,created_at);
CREATE INDEX runs_start_day ON runs(user_id,started_day);
CREATE INDEX accounts_owner ON accounts(user_id);
CREATE TABLE quota_reservations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES members(id),day TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('chat','model')),created_at TEXT NOT NULL);
CREATE INDEX quota_day ON quota_reservations(day,kind,user_id);
INSERT INTO settings(key,value) VALUES('globalDailyModels','2000');
INSERT INTO settings(key,value) VALUES('claimsEnabled','1');
CREATE TABLE auth_user(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,emailVerified INTEGER NOT NULL DEFAULT 0,image TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE TABLE auth_session(id TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL,token TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,ipAddress TEXT,userAgent TEXT,userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE);
CREATE INDEX auth_session_user ON auth_session(userId);
CREATE TABLE auth_account(id TEXT PRIMARY KEY,accountId TEXT NOT NULL,providerId TEXT NOT NULL,userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,accessToken TEXT,refreshToken TEXT,idToken TEXT,accessTokenExpiresAt INTEGER,refreshTokenExpiresAt INTEGER,scope TEXT,password TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE INDEX auth_account_user ON auth_account(userId);
CREATE TABLE auth_verification(id TEXT PRIMARY KEY,identifier TEXT NOT NULL,value TEXT NOT NULL,expiresAt INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE INDEX auth_verification_identifier ON auth_verification(identifier);
CREATE TABLE auth_rate_limit(id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,count INTEGER NOT NULL,lastRequest INTEGER NOT NULL);
CREATE TABLE request_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);

-- These guards execute inside the same D1 transaction as the mutation, including concurrent claims.
CREATE TRIGGER run_queue_limit BEFORE INSERT ON runs
WHEN NEW.status='queued' AND NOT EXISTS(SELECT 1 FROM runs WHERE idempotency_key=NEW.idempotency_key)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND disabled=0) THEN RAISE(ABORT,'USER_DISABLED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND status='queued') >= (SELECT queued_runs FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'QUEUE_LIMIT') END;
END;
CREATE TRIGGER claim_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND disabled=0) THEN RAISE(ABORT,'USER_DISABLED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM runs WHERE id<>NEW.id AND status IN ('running','waiting_user','verifying') AND (user_id=NEW.user_id OR device_id=NEW.device_id)) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM accounts WHERE id=json_extract(NEW.task_snapshot,'$.accountId') AND (user_id<>NEW.user_id OR (assigned_device_id IS NOT NULL AND assigned_device_id<>NEW.device_id))) THEN RAISE(ABORT,'ACCOUNT_DEVICE_MISMATCH') END;
END;
CREATE TRIGGER claim_record AFTER UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 UPDATE members SET last_claim_at=NEW.updated_at WHERE id=NEW.user_id;
 UPDATE accounts SET assigned_device_id=NEW.device_id WHERE id=json_extract(NEW.task_snapshot,'$.accountId') AND user_id=NEW.user_id AND assigned_device_id IS NULL;
END;
CREATE TRIGGER task_schedule_insert BEFORE INSERT ON tasks
WHEN NEW.status IN ('active','pending_validation') AND json_extract(NEW.definition,'$.schedule.kind')='cron'
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM tasks WHERE user_id=NEW.user_id AND status IN ('active','pending_validation') AND json_extract(definition,'$.schedule.kind')='cron') >= (SELECT scheduled_tasks FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'SCHEDULE_QUOTA_EXCEEDED') END;
END;
CREATE TRIGGER task_schedule_update BEFORE UPDATE ON tasks
WHEN NEW.status IN ('active','pending_validation') AND json_extract(NEW.definition,'$.schedule.kind')='cron'
 AND (OLD.status NOT IN ('active','pending_validation') OR json_extract(OLD.definition,'$.schedule.kind')<>'cron' OR OLD.user_id<>NEW.user_id)
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM tasks WHERE id<>NEW.id AND user_id=NEW.user_id AND status IN ('active','pending_validation') AND json_extract(definition,'$.schedule.kind')='cron') >= (SELECT scheduled_tasks FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'SCHEDULE_QUOTA_EXCEEDED') END;
END;

-- Password updates and session revocation are atomic even without adapter transactions.
CREATE TRIGGER password_revoke AFTER UPDATE OF password ON auth_account
WHEN NEW.password IS NOT OLD.password
BEGIN DELETE FROM auth_session WHERE userId=NEW.userId; END;
