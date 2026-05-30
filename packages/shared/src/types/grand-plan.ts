export type GrandPlanTier = "prd" | "spec" | "plan";
export type GrandPlanReconcileState = "current" | "parent_changed";

export interface GrandPlanNode {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  tier: GrandPlanTier;
  title: string;
  documentId: string | null;
  sourceRevisionId: string | null;
  reconcileState: GrandPlanReconcileState;
  rollupPercent: number;
  ownerAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrandPlanTreeNode extends GrandPlanNode {
  children: GrandPlanTreeNode[];
}

/**
 * A lightweight issue summary used by the read-only Grand Plan view. Carries
 * just enough to render a row plus its nested sub-issues (issues whose
 * parentId points at this issue).
 */
export interface GrandPlanViewIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  children: GrandPlanViewIssue[];
}

/**
 * A node in the read-only Grand Plan view tree. Extends the base tree node with:
 * - `issues`: issues tethered to THIS node (grandPlanNodeId = node.id), each
 *   carrying its own nested sub-issues.
 * - `uncovered`: true when this is a PRD-clause node (tier "prd", parented to the
 *   PRD document root) that has no spec/plan descendants — i.e. no coverage yet.
 */
export interface GrandPlanViewNode extends GrandPlanNode {
  children: GrandPlanViewNode[];
  issues: GrandPlanViewIssue[];
  uncovered: boolean;
}

/**
 * Payload for `GET /companies/:companyId/grand-plan/view`.
 * - `tree`: the PRD document-root node with its clause → spec → plan subtree,
 *   each node carrying tethered issues + an `uncovered` flag. Null when no
 *   grand plan exists for the company.
 * - `driftIssues`: company issues that cannot trace to a PRD clause — either
 *   `grandPlanNodeId` is null, or the node's lineage never reaches a tier "prd"
 *   node. Sub-issues nest under their parent drift issue.
 */
export interface GrandPlanView {
  tree: GrandPlanViewNode | null;
  driftIssues: GrandPlanViewIssue[];
}
