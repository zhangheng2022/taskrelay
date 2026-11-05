-- 大检查点先加密再分块；外键确保替换、撤回、删除和保留期清理不遗留密文。
CREATE TABLE ai_checkpoint_chunks (
 owner TEXT NOT NULL, thread TEXT NOT NULL, ns TEXT NOT NULL, checkpoint TEXT NOT NULL,
 field TEXT NOT NULL CHECK(field IN ('checkpoint','metadata')), token TEXT NOT NULL,
 part INTEGER NOT NULL CHECK(part>=0), value TEXT NOT NULL,
 PRIMARY KEY(owner,thread,ns,checkpoint,field,part),
 FOREIGN KEY(owner,thread,ns,checkpoint) REFERENCES ai_checkpoints(owner,thread,ns,id) ON DELETE CASCADE
);
CREATE TABLE ai_write_chunks (
 owner TEXT NOT NULL, thread TEXT NOT NULL, ns TEXT NOT NULL, checkpoint TEXT NOT NULL,
 task TEXT NOT NULL, idx INTEGER NOT NULL, token TEXT NOT NULL,
 part INTEGER NOT NULL CHECK(part>=0), value TEXT NOT NULL,
 PRIMARY KEY(owner,thread,ns,checkpoint,task,idx,part),
 FOREIGN KEY(owner,thread,ns,checkpoint,task,idx) REFERENCES ai_writes(owner,thread,ns,checkpoint,task,idx) ON DELETE CASCADE
);
