/**
 * B2 — the PRD-change cascade.
 *
 * When a Grand Plan PRD document is revised, this cascade:
 *   1. Finds the grand_plan doc-root node attached to that document (guard: if
 *      none, the edited document is not a Grand Plan PRD — do nothing).
 *   2. Diffs the PRD clauses between the old and new body (added/changed/removed).
 *   3. Flags every changed/removed clause node AND its descendants
 *      `reconcileState='parent_changed'` (a "needs human review" marker).
 *   4. Raises ONE `grand_plan_reconcile` approval to the human owner (idempotent:
 *      never a second pending one for the same document).
 *
 * PRODUCT DECISIONS (owner-confirmed):
 *   - Orchestrate, don't author: the cascade flags + (on approval) creates new
 *     clause HEADER nodes + tasks the CEO. It never writes issue/spec/plan content.
 *   - Removed clauses: flag only, NEVER auto-delete any node or issue.
 *
 * The whole cascade is best-effort and must NEVER fail the document save:
 * everything is wrapped in try/catch + logger.warn.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, grandPlanNodes, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { approvalService as makeApprovalService } from "./approvals.js";
import { grandPlanService as makeGrandPlanService } from "./grand-plan.js";
import { diffPrdClauses } from "./grand-plan-prd-clauses.js";

export interface PrdCascadeDeps {
  /** Override the approval service (used by tests). Defaults to one over `db`. */
  approvalService?: ReturnType<typeof makeApprovalService>;
  /** Override the grand plan service. Defaults to one over `db`. */
  grandPlanService?: ReturnType<typeof makeGrandPlanService>;
}

export interface PrdCascadeInput {
  documentId: string;
  companyId: string;
  oldBody: string;
  newBody: string;
  fromRevisionId: string | null;
  toRevisionId: string | null;
}

/**
 * Find the grand_plan doc-root node for a document: the node whose
 * `documentId` = the edited document, `parentId` is null, and `tier='prd'`.
 * Returns null when the document is not a Grand Plan PRD root.
 */
async function findDocRoot(db: Db, documentId: string) {
  return db
    .select()
    .from(grandPlanNodes)
    .where(
      and(
        eq(grandPlanNodes.documentId, documentId),
        isNull(grandPlanNodes.parentId),
        eq(grandPlanNodes.tier, "prd"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Part A — detection + flag + raise approval. Runs AFTER the document-save
 * transaction commits. Never throws.
 *
 * NOTE: the CEO is NOT woken here. The raised approval goes to the human owner
 * for sign-off; only once it is APPROVED does the CEO get woken to author the
 * ripple (see `applyGrandPlanReconcile` in approvals.ts).
 */
export async function runPrdChangeCascade(
  db: Db,
  deps: PrdCascadeDeps,
  input: PrdCascadeInput,
): Promise<void> {
  try {
    const grandPlan = deps.grandPlanService ?? makeGrandPlanService(db);
    const approvalSvc = deps.approvalService ?? makeApprovalService(db);

    // 1) Guard: only Grand Plan PRD documents cascade.
    const root = await findDocRoot(db, input.documentId);
    if (!root) return;

    // 2) Diff clauses old vs new.
    const { added, changed, removed } = diffPrdClauses(input.oldBody, input.newBody);
    if (added.length === 0 && changed.length === 0 && removed.length === 0) return;

    // Build a title -> clause-node map for clause nodes under this doc root.
    const clauseNodeRows = await db
      .select()
      .from(grandPlanNodes)
      .where(
        and(eq(grandPlanNodes.companyId, root.companyId), eq(grandPlanNodes.parentId, root.id)),
      );
    const clauseNodeByTitle = new Map(clauseNodeRows.map((n) => [n.title, n]));

    // 3) Flag downstream: each changed/removed clause node + every descendant.
    const affectedClauseNodeIds: string[] = [];
    const affectedNodeIds = new Set<string>();
    for (const clauseId of [...changed, ...removed]) {
      const node = clauseNodeByTitle.get(clauseId);
      if (!node) continue; // added clauses have no node yet; removed-without-node = nothing to flag
      affectedClauseNodeIds.push(node.id);
      affectedNodeIds.add(node.id);
      const descendants = await grandPlan.getDescendants(node.id);
      for (const d of descendants) affectedNodeIds.add(d.id);
    }
    for (const nodeId of affectedNodeIds) {
      await grandPlan.setReconcileState(nodeId, "parent_changed");
    }

    // Count issues tethered to any affected node (for the approval summary).
    let affectedIssueCount = 0;
    if (affectedNodeIds.size > 0) {
      const tethered = await db
        .select({ id: issues.id, grandPlanNodeId: issues.grandPlanNodeId })
        .from(issues)
        .where(eq(issues.companyId, root.companyId));
      affectedIssueCount = tethered.filter(
        (i) => i.grandPlanNodeId != null && affectedNodeIds.has(i.grandPlanNodeId),
      ).length;
    }

    // 4) Raise ONE approval. Idempotency: if a PENDING grand_plan_reconcile
    // approval already references this documentId, do not raise a second. We
    // leave the existing one as-is (it still points at the in-flight change set;
    // the human reviews the latest doc state when they act on it).
    const existing = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, root.companyId),
          eq(approvals.type, "grand_plan_reconcile"),
          eq(approvals.status, "pending"),
          sql`${approvals.payload}->>'documentId' = ${input.documentId}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      await approvalSvc.create(root.companyId, {
        type: "grand_plan_reconcile",
        status: "pending",
        payload: {
          documentId: input.documentId,
          fromRevisionId: input.fromRevisionId,
          toRevisionId: input.toRevisionId,
          added,
          changed,
          removed,
          affectedClauseNodeIds,
          affectedIssueCount,
        },
      });
    }
  } catch (err) {
    logger.warn(
      { err, documentId: input.documentId },
      "PRD-change cascade failed (grand plan B2); document save unaffected",
    );
  }
}
