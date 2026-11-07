ALTER TABLE runs ADD COLUMN reconciliation_of TEXT;
CREATE INDEX run_reconciliation ON runs(reconciliation_of,status);
