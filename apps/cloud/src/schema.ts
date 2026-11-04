import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const tasksTable = sqliteTable("tasks", {
  userId: text("user_id").notNull(),
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  definition: text("definition").notNull(),
  status: text("status").notNull(),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const devicesTable = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lastSeen: text("last_seen"),
  revoked: integer("revoked").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
});
