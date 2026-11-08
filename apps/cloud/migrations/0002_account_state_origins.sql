-- 登录成功落点仅用于浏览器状态采集与恢复，不授予凭据投递或业务账号匹配权限。
-- 既有账号保持原范围；来源只在本人确认未修改的已验证卡片时写入。
ALTER TABLE accounts ADD COLUMN state_origins TEXT NOT NULL DEFAULT '[]';
