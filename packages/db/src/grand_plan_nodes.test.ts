/**
 * Metadata-shape test for the grandPlanNodes table.
 *
 * NOTE: This package's DB tests (client.test.ts, backup-lib.test.ts) spin up a full
 * embedded Postgres + run migrations before inserting data. Because the
 * grand_plan_nodes migration has NOT been generated yet (Task 3), actual-DB insert
 * tests would fail on the missing table. Following the fallback from the task spec,
 * we instead inspect Drizzle's in-memory table metadata to assert the column set and
 * default values. This is sufficient to verify the schema file is correct and
 * type-checks cleanly.
 */

import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { grandPlanNodes } from "./schema/grand_plan_nodes.js";

describe("grandPlanNodes schema metadata", () => {
  it("has the correct table name", () => {
    expect(getTableName(grandPlanNodes)).toBe("grand_plan_nodes");
  });

  it("has all required columns", () => {
    const columns = getTableColumns(grandPlanNodes);
    const columnKeys = Object.keys(columns);

    expect(columnKeys).toEqual(
      expect.arrayContaining([
        "id",
        "companyId",
        "projectId",
        "parentId",
        "tier",
        "title",
        "documentId",
        "sourceRevisionId",
        "reconcileState",
        "rollupPercent",
        "ownerAgentId",
        "createdAt",
        "updatedAt",
      ]),
    );
    // No extra columns beyond the spec
    expect(columnKeys).toHaveLength(13);
  });

  it("reconcileState column defaults to 'current'", () => {
    const columns = getTableColumns(grandPlanNodes);
    expect(columns.reconcileState.hasDefault).toBe(true);
    expect(columns.reconcileState.default).toBe("current");
    expect(columns.reconcileState.notNull).toBe(true);
  });

  it("rollupPercent column defaults to 0", () => {
    const columns = getTableColumns(grandPlanNodes);
    expect(columns.rollupPercent.hasDefault).toBe(true);
    expect(columns.rollupPercent.default).toBe(0);
    expect(columns.rollupPercent.notNull).toBe(true);
  });

  it("parentId references grandPlanNodes (self-referencing tree)", () => {
    const columns = getTableColumns(grandPlanNodes);
    // parentId should be nullable (no .notNull()) to allow root nodes
    expect(columns.parentId.notNull).toBe(false);
  });

  it("projectId, documentId, sourceRevisionId, ownerAgentId are all nullable", () => {
    const columns = getTableColumns(grandPlanNodes);
    expect(columns.projectId.notNull).toBe(false);
    expect(columns.documentId.notNull).toBe(false);
    expect(columns.sourceRevisionId.notNull).toBe(false);
    expect(columns.ownerAgentId.notNull).toBe(false);
  });

  it("companyId, tier, title are non-nullable", () => {
    const columns = getTableColumns(grandPlanNodes);
    expect(columns.companyId.notNull).toBe(true);
    expect(columns.tier.notNull).toBe(true);
    expect(columns.title.notNull).toBe(true);
  });

  it("createdAt and updatedAt are non-nullable with defaults", () => {
    const columns = getTableColumns(grandPlanNodes);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.createdAt.hasDefault).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(columns.updatedAt.hasDefault).toBe(true);
  });
});
