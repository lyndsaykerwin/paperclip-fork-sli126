import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { grandPlanNodes, issues } from "@paperclipai/db";
import type {
  GrandPlanNode,
  GrandPlanReconcileState,
  GrandPlanTier,
  GrandPlanTreeNode,
  GrandPlanView,
  GrandPlanViewIssue,
  GrandPlanViewNode,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type GrandPlanNodeRow = typeof grandPlanNodes.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function rowToViewIssue(row: IssueRow): GrandPlanViewIssue {
  return {
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status,
    children: [],
  };
}

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
     * Assemble the read-only Grand Plan VIEW for a company+project:
     *   - the PRD document-root subtree (clause → spec → plan), each node
     *     carrying its tethered issues (with nested sub-issues) and an
     *     `uncovered` flag,
     *   - a flat `driftIssues` list for issues that cannot trace to a PRD clause.
     *
     * Definitions:
     *   - "tethered" issue = an issue whose `grandPlanNodeId` equals a node id.
     *     Tethered issues are attached to that exact node. A tethered issue's
     *     sub-issues (issues whose `parentId` points at it) nest under it rather
     *     than appearing again at the node level.
     *   - "uncovered" = a PRD-clause node (tier "prd", parented to the doc root)
     *     with no spec/plan descendants — i.e. no coverage yet.
     *   - "drift" = an issue that is NOT a sub-issue of a tethered issue AND
     *     either has a null `grandPlanNodeId`, or its node's lineage (walking
     *     `parentId` up the node tree) never reaches a tier "prd" node.
     */
    getView: async (
      companyId: string,
      projectId: string | null | undefined,
    ): Promise<GrandPlanView> => {
      const projectCondition =
        projectId == null
          ? isNull(grandPlanNodes.projectId)
          : eq(grandPlanNodes.projectId, projectId);

      // --- Load all nodes for this company+project ---
      const nodeRows = await db
        .select()
        .from(grandPlanNodes)
        .where(and(eq(grandPlanNodes.companyId, companyId), projectCondition));

      const nodeById = new Map<string, GrandPlanNodeRow>();
      for (const row of nodeRows) nodeById.set(row.id, row);

      // Node id -> set of true when its lineage reaches a tier "prd" node.
      const nodeTracesToPrd = (nodeId: string | null): boolean => {
        let currentId: string | null = nodeId;
        const seen = new Set<string>();
        while (currentId != null && !seen.has(currentId)) {
          seen.add(currentId);
          const node = nodeById.get(currentId);
          if (!node) return false;
          if (node.tier === "prd") return true;
          currentId = node.parentId ?? null;
        }
        return false;
      };

      // --- Load ALL company issues (drift must consider issues that don't tether
      // to ANY node for this company, regardless of project). ---
      const issueRows = await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, companyId));

      // Build parentIssueId -> children map for sub-issue nesting.
      const childIssuesByParent = new Map<string, IssueRow[]>();
      for (const row of issueRows) {
        if (row.parentId != null) {
          const list = childIssuesByParent.get(row.parentId) ?? [];
          list.push(row);
          childIssuesByParent.set(row.parentId, list);
        }
      }

      // Recursively assemble an issue + its sub-issues. `claimed` records every
      // issue id placed somewhere in the tree so it is not double-listed.
      const claimed = new Set<string>();
      function buildIssue(row: IssueRow): GrandPlanViewIssue {
        claimed.add(row.id);
        const kids = childIssuesByParent.get(row.id) ?? [];
        return {
          ...rowToViewIssue(row),
          children: kids.map(buildIssue),
        };
      }

      // Tethered issues grouped by node id. Only top-level tethered issues
      // (those that are not themselves a sub-issue of another tethered issue)
      // are attached at the node; their sub-issues nest beneath them.
      const tetheredTopLevelByNode = new Map<string, IssueRow[]>();
      for (const row of issueRows) {
        if (row.grandPlanNodeId == null) continue;
        // Skip sub-issues whose parent is also tethered to a node — they nest
        // under their parent instead of attaching directly to the node.
        const parent = row.parentId != null ? issueRows.find((r) => r.id === row.parentId) : null;
        if (parent && parent.grandPlanNodeId != null) continue;
        const list = tetheredTopLevelByNode.get(row.grandPlanNodeId) ?? [];
        list.push(row);
        tetheredTopLevelByNode.set(row.grandPlanNodeId, list);
      }

      // --- Build node->children map and assemble the view tree ---
      const childNodesByParent = new Map<string, GrandPlanNodeRow[]>();
      for (const row of nodeRows) {
        if (row.parentId != null) {
          const list = childNodesByParent.get(row.parentId) ?? [];
          list.push(row);
          childNodesByParent.set(row.parentId, list);
        }
      }

      const rootRow = nodeRows.find((r) => r.parentId == null && r.tier === "prd") ?? null;

      // A PRD-clause node is "uncovered" when none of its descendants is a
      // spec or plan node.
      const hasSpecOrPlanDescendant = (nodeId: string): boolean => {
        const queue = [...(childNodesByParent.get(nodeId) ?? [])];
        while (queue.length > 0) {
          const node = queue.shift()!;
          if (node.tier === "spec" || node.tier === "plan") return true;
          queue.push(...(childNodesByParent.get(node.id) ?? []));
        }
        return false;
      };

      function buildViewNode(row: GrandPlanNodeRow, isDocRoot: boolean): GrandPlanViewNode {
        const childRows = childNodesByParent.get(row.id) ?? [];
        const tethered = tetheredTopLevelByNode.get(row.id) ?? [];
        // A PRD-clause node is a non-root prd-tier node. The document root
        // itself is never flagged uncovered.
        const isClause = row.tier === "prd" && !isDocRoot;
        const uncovered = isClause && !hasSpecOrPlanDescendant(row.id);
        return {
          ...rowToNode(row),
          children: childRows.map((c) => buildViewNode(c, false)),
          issues: tethered.map(buildIssue),
          uncovered,
        };
      }

      const tree = rootRow ? buildViewNode(rootRow, true) : null;

      // --- Drift list: issues not claimed into the tree that cannot trace to a
      // PRD clause. A null grandPlanNodeId is always drift; a tethered issue is
      // drift only if its node lineage never reaches a tier "prd" node. ---
      const driftIssues: GrandPlanViewIssue[] = [];
      for (const row of issueRows) {
        if (claimed.has(row.id)) continue;
        // Sub-issues are surfaced under their parent (drift or tethered); only
        // consider issues that are not themselves nested under a parent issue
        // we will render, to avoid duplicates. Top-level = no parent, or parent
        // is not a company issue we loaded.
        const hasRenderedParent =
          row.parentId != null && issueRows.some((r) => r.id === row.parentId);
        if (hasRenderedParent) continue;

        const traces = row.grandPlanNodeId != null && nodeTracesToPrd(row.grandPlanNodeId);
        if (!traces) {
          driftIssues.push(buildIssue(row));
        }
      }

      return { tree, driftIssues };
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
