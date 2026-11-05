-- Remove project-defined global daily admission caps; retain per-user usage.
DROP TABLE IF EXISTS platform_budget;
DELETE FROM settings WHERE key='globalDailyModels';
