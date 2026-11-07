-- 凭据版本保留到旧执行释放，设置中的修改不会替换正在使用的账号密码。
CREATE TABLE account_credential_versions (
 account_id TEXT NOT NULL REFERENCES accounts(id), version INTEGER NOT NULL,
 secret TEXT NOT NULL, login_origins TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,version)
);
INSERT INTO account_credential_versions(account_id,version,secret,login_origins,created_at)
 SELECT id,credential_version,secret,login_origins,created_at FROM accounts;

-- 聊天只引用卡片 ID；临时凭据、验证依据和域名清单均在 secret 中加密。
CREATE TABLE account_cards (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
 lease_epoch INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('save','update')),
 account_id TEXT, credential_version INTEGER, state_epoch INTEGER,
 secret TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','saved','dismissed','expired')),
 input_digest TEXT NOT NULL, confirm_digest TEXT, result_account_id TEXT, resumed INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 wait_for_update INTEGER NOT NULL DEFAULT 0,user_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX account_cards_run ON account_cards(run_id,status);
CREATE INDEX account_cards_expiry ON account_cards(status,expires_at);
CREATE TRIGGER account_cards_close AFTER UPDATE OF closed ON ai_threads WHEN NEW.closed=1
 BEGIN UPDATE account_cards SET status=CASE WHEN status='pending' THEN 'expired' ELSE status END,secret=NULL WHERE thread_id=NEW.id; END;
CREATE TRIGGER account_cards_withdraw AFTER UPDATE OF context_withdrawn,history_deleted ON runs
 WHEN NEW.context_withdrawn=1 OR NEW.history_deleted=1
 BEGIN UPDATE account_cards SET status=CASE WHEN status='pending' THEN 'expired' ELSE status END,secret=NULL WHERE run_id=NEW.id; END;
