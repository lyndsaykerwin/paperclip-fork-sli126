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
