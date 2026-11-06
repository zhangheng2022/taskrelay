-- 账号拥有状态版本，D1 授权与发布，私有 DO 保存不可变加密内容。
ALTER TABLE accounts ADD COLUMN business_domains TEXT NOT NULL DEFAULT '[]';
ALTER TABLE accounts ADD COLUMN login_origins TEXT NOT NULL DEFAULT '[]';
ALTER TABLE accounts ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN state_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN credential_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE accounts ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN state_object_key TEXT;
ALTER TABLE accounts ADD COLUMN previous_state_object_key TEXT;
ALTER TABLE accounts ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE accounts ADD COLUMN sync_error TEXT;
ALTER TABLE accounts ADD COLUMN last_device_id TEXT;
ALTER TABLE accounts ADD COLUMN state_owner_run_id TEXT;
UPDATE accounts SET login_origins=json_array(origin),last_device_id=assigned_device_id;
ALTER TABLE devices ADD COLUMN claim_ready INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN account_id TEXT;
ALTER TABLE runs ADD COLUMN account_credential_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN account_state_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cleanup_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN state_candidate_key TEXT;
UPDATE runs SET account_id=json_extract(task_snapshot,'$.accountId');
UPDATE runs SET cleanup_pending=1 WHERE status IN ('running','waiting_user','verifying','unknown');
UPDATE accounts SET state_owner_run_id=(SELECT run_id FROM account_locks WHERE account_key=accounts.id);
CREATE TABLE browser_state_candidates(
 object_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT,run_id TEXT NOT NULL,
 device_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,credential_version INTEGER NOT NULL,
 state_epoch INTEGER NOT NULL,base_revision INTEGER NOT NULL,origins TEXT NOT NULL,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0,clear_previous INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX browser_state_run ON browser_state_candidates(run_id,created_at);
CREATE TABLE browser_state_retirements(object_key TEXT PRIMARY KEY,retired_at TEXT NOT NULL);
