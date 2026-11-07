-- Remove task website allowlists without deleting task or run history.
UPDATE tasks SET definition=json_remove(definition,'$.allowedOrigins');
UPDATE task_versions SET definition=json_remove(definition,'$.allowedOrigins');
UPDATE runs SET task_snapshot=json_remove(task_snapshot,'$.allowedOrigins');
UPDATE ai_threads SET draft=json_remove(draft,'$.allowedOrigins') WHERE draft IS NOT NULL;
ALTER TABLE ai_threads DROP COLUMN origins;
