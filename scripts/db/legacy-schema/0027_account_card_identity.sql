-- 同一运行、代次与凭据身份只保留一个有效确认入口；旧草稿由鉴权接口解密后惰性归并。
ALTER TABLE account_cards ADD COLUMN identity_digest TEXT;
ALTER TABLE account_cards ADD COLUMN superseded_by TEXT;
CREATE UNIQUE INDEX account_card_identity ON account_cards(run_id,lease_epoch,identity_digest)
 WHERE identity_digest IS NOT NULL AND status IN ('pending','saved');
