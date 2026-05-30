import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { documents } from "./documents.js";
import { projects } from "./projects.js";

export const grandPlanNodes = pgTable(
  "grand_plan_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => grandPlanNodes.id),
    tier: text("tier").notNull(),
    title: text("title").notNull(),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    sourceRevisionId: uuid("source_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    reconcileState: text("reconcile_state").notNull().default("current"),
    rollupPercent: integer("rollup_percent").notNull().default(0),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("grand_plan_nodes_company_id_idx").on(table.companyId),
    parentIdx: index("grand_plan_nodes_parent_id_idx").on(table.parentId),
    projectIdx: index("grand_plan_nodes_project_id_idx").on(table.projectId),
  }),
);
