import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { grandPlanNodes } from "@paperclipai/db";
import type {
  GrandPlanNode,
  GrandPlanReconcileState,
  GrandPlanTier,
  GrandPlanTreeNode,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type GrandPlanNodeRow = typeof grandPlanNodes.$inferSelect;

function rowToNode(row: GrandPlanNodeRow): GrandPlanNode {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    parentId: row.parentId ?? null,
    tier: row.tier as GrandPlanTier,
    title: row.title,
    documentId: row.documentId ?? null,
    sourceRevisionId: row.sourceRevisionId ?? null,
    reconcileState: row.reconcileState as GrandPlanReconcileState,
    rollupPercent: row.rollupPercent,
    ownerAgentId: row.ownerAgentId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateGrandPlanNodeInput {
  companyId: string;
  projectId?: string | null;
  parentId?: string | null;
  tier: GrandPlanTier;
  title: string;
  ownerAgentId?: string | null;
}

export function grandPlanService(db: Db) {
  /**
   * Build the root-uniqueness WHERE condition for a (companyId, projectId) pair.
   * projectId is nullable; treat null and a specific UUID as distinct scopes.
   */
  function rootWhereCondition(companyId: string, projectId: string | null | undefined) {
    const projectCondition =
      projectId == null
        ? isNull(grandPlanNodes.projectId)
        : eq(grandPlanNodes.projectId, projectId);

    return and(
      eq(grandPlanNodes.companyId, companyId),
      projectCondition,
      eq(grandPlanNodes.tier, "prd"),
      isNull(grandPlanNodes.parentId),
    );
  }

  return {
    /**
     * Insert a new node. For prd-tier root nodes (parentId null), enforces
     * uniqueness: only one prd root per (companyId, projectId) pair is allowed.
     */
    create: async (input: CreateGrandPlanNodeInput): Promise<GrandPlanNode> => {
      return db.transaction(async (tx) => {
        // Enforce root-uniqueness for prd roots
        if (input.tier === "prd" && input.parentId == null) {
          const existing = await tx
            .select()
            .from(grandPlanNodes)
            .where(rootWhereCondition(input.companyId, input.projectId))
            .then((rows) => rows[0] ?? null);

          if (existing) {
            throw unprocessable(
              "A prd root node already exists for this company and project. Only one prd root is allowed.",
            );
          }
        }

        const row = await tx
          .insert(grandPlanNodes)
          .values({
            companyId: input.companyId,
            projectId: input.projectId ?? null,
            parentId: input.parentId ?? null,
            tier: input.tier,
            title: input.title,
            ownerAgentId: input.ownerAgentId ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        if (!row) {
          throw new Error("Failed to insert grand plan node");
        }

        return rowToNode(row);
      });
    },

    /** Fetch a node by its primary key. Returns null if not found. */
    getById: async (id: string): Promise<GrandPlanNode | null> => {
      const row = await db
        .select()
        .from(grandPlanNodes)
        .where(eq(grandPlanNodes.id, id))
        .then((rows) => rows[0] ?? null);

      return row ? rowToNode(row) : null;
    },

    /**
     * Return the prd root node (parentId null, tier "prd") for the given
     * company+project pair. Returns null when none exists yet.
     */
    getRoot: async (
      companyId: string,
      projectId: string | null | undefined,
    ): Promise<GrandPlanNode | null> => {
      const row = await db
        .select()
        .from(grandPlanNodes)
        .where(rootWhereCondition(companyId, projectId))
        .then((rows) => rows[0] ?? null);

      return row ? rowToNode(row) : null;
    },

    /**
     * Walk parentId upward from `id`, returning ancestors in nearest-parent-first
     * order (i.e. the direct parent is [0], grandparent is [1], …). The node
     * itself is NOT included.
     */
    getAncestors: async (id: string): Promise<GrandPlanNode[]> => {
      const ancestors: GrandPlanNode[] = [];
      let currentId: string | null = id;

      // First fetch the starting node to get its parentId
      const startRow = await db
        .select()
        .from(grandPlanNodes)
        .where(eq(grandPlanNodes.id, currentId))
        .then((rows) => rows[0] ?? null);

      if (!startRow) return [];

      currentId = startRow.parentId ?? null;

      // Walk up the tree
      while (currentId != null) {
        const row = await db
          .select()
          .from(grandPlanNodes)
          .where(eq(grandPlanNodes.id, currentId))
          .then((rows) => rows[0] ?? null);

        if (!row) break;
        ancestors.push(rowToNode(row));
        currentId = row.parentId ?? null;
      }

      return ancestors;
    },

    /**
     * Return all nodes below `id` at any depth. Does not include the node itself.
     */
    getDescendants: async (id: string): Promise<GrandPlanNode[]> => {
      // Iterative BFS / DFS over the tree
      const result: GrandPlanNode[] = [];
      const queue: string[] = [id];

      while (queue.length > 0) {
        const currentId = queue.shift()!;
        const children = await db
          .select()
          .from(grandPlanNodes)
          .where(eq(grandPlanNodes.parentId, currentId));

        for (const child of children) {
          result.push(rowToNode(child));
          queue.push(child.id);
        }
      }

      return result;
    },

    /**
     * Fetch the entire subtree rooted at the prd root for the given company+project
     * and assemble it into a nested GrandPlanTreeNode structure.
     * Returns null if no root exists.
     */
    getTree: async (
      companyId: string,
      projectId: string | null | undefined,
    ): Promise<GrandPlanTreeNode | null> => {
      const projectCondition =
        projectId == null
          ? isNull(grandPlanNodes.projectId)
          : eq(grandPlanNodes.projectId, projectId);

      // Fetch all nodes for this company+project in one query
      const allRows = await db
        .select()
        .from(grandPlanNodes)
        .where(and(eq(grandPlanNodes.companyId, companyId), projectCondition));

      if (allRows.length === 0) return null;

      // Find root
      const rootRow = allRows.find((r) => r.parentId == null && r.tier === "prd");
      if (!rootRow) return null;

      // Build a parentId → children map
      const childrenMap = new Map<string, GrandPlanNodeRow[]>();
      for (const row of allRows) {
        if (row.parentId != null) {
          const siblings = childrenMap.get(row.parentId) ?? [];
          siblings.push(row);
          childrenMap.set(row.parentId, siblings);
        }
      }

      function buildTree(row: GrandPlanNodeRow): GrandPlanTreeNode {
        const children = childrenMap.get(row.id) ?? [];
        return {
          ...rowToNode(row),
          children: children.map(buildTree),
        };
      }

      return buildTree(rootRow);
    },

    /**
     * Set the documentId and sourceRevisionId columns on a node.
     * Passing null clears the columns.
     */
    attachDocument: async (
      nodeId: string,
      documentId: string | null,
      revisionId: string | null,
    ): Promise<GrandPlanNode> => {
      const now = new Date();
      const row = await db
        .update(grandPlanNodes)
        .set({
          documentId: documentId ?? null,
          sourceRevisionId: revisionId ?? null,
          updatedAt: now,
        })
        .where(eq(grandPlanNodes.id, nodeId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!row) {
        throw new Error(`Grand plan node not found: ${nodeId}`);
      }

      return rowToNode(row);
    },

    /** Update the reconcileState column on a node. */
    setReconcileState: async (
      id: string,
      state: GrandPlanReconcileState,
    ): Promise<GrandPlanNode> => {
      const now = new Date();
      const row = await db
        .update(grandPlanNodes)
        .set({ reconcileState: state, updatedAt: now })
        .where(eq(grandPlanNodes.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!row) {
        throw new Error(`Grand plan node not found: ${id}`);
      }

      return rowToNode(row);
    },

    /** Update the rollupPercent column on a node. */
    setRollupPercent: async (id: string, percent: number): Promise<GrandPlanNode> => {
      const now = new Date();
      const row = await db
        .update(grandPlanNodes)
        .set({ rollupPercent: percent, updatedAt: now })
        .where(eq(grandPlanNodes.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!row) {
        throw new Error(`Grand plan node not found: ${id}`);
      }

      return rowToNode(row);
    },
  };
}
