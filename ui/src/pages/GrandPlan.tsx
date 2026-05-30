import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ListTree, AlertTriangle } from "lucide-react";
import type {
  GrandPlanView,
  GrandPlanViewIssue,
  GrandPlanViewNode,
} from "@paperclipai/shared";
import { grandPlanApi } from "../api/grandPlan";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { cn } from "../lib/utils";

const TIER_LABEL: Record<string, string> = {
  prd: "PRD",
  spec: "Spec",
  plan: "Plan",
};

const TIER_CLASS: Record<string, string> = {
  prd: "bg-violet-600 text-white",
  spec: "bg-blue-600 text-white",
  plan: "bg-teal-600 text-white",
};

function TierBadge({ tier }: { tier: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shrink-0",
        TIER_CLASS[tier] ?? "bg-muted text-muted-foreground",
      )}
    >
      {TIER_LABEL[tier] ?? tier}
    </span>
  );
}

function IssueTierBadge({ isSub }: { isSub: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shrink-0 bg-background text-muted-foreground",
        isSub ? "border-dashed" : "border-border",
      )}
    >
      {isSub ? "sub" : "issue"}
    </span>
  );
}

function RollupBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span className="flex w-[120px] shrink-0 items-center gap-2" data-testid="rollup-bar">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-foreground"
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
        {clamped}%
      </span>
    </span>
  );
}

function IssueRow({ issue, depth, isSub }: { issue: GrandPlanViewIssue; depth: number; isSub: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = issue.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer hover:bg-accent/50"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => hasChildren && setExpanded((v) => !v)}
      >
        {hasChildren ? (
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <IssueTierBadge isSub={isSub} />
        {issue.identifier && (
          <span className="text-xs tabular-nums text-muted-foreground">{issue.identifier}</span>
        )}
        <span className="flex-1 truncate">{issue.title}</span>
        <StatusBadge status={issue.status} />
      </div>
      {hasChildren && expanded && (
        <div>
          {issue.children.map((child) => (
            <IssueRow key={child.id} issue={child} depth={depth + 1} isSub />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanNodeRow({ node, depth }: { node: GrandPlanViewNode; depth: number }) {
  // Collapsed by default at every level (progressive disclosure) — matches the prototype.
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0 || node.issues.length > 0;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer hover:bg-accent/50",
          node.uncovered && "bg-orange-50",
        )}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => hasChildren && setExpanded((v) => !v)}
        data-testid={`node-${node.id}`}
      >
        {hasChildren ? (
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <TierBadge tier={node.tier} />
        <span className={cn("flex-1 truncate", node.tier === "prd" && "font-semibold")}>
          {node.title}
        </span>
        <RollupBar percent={node.rollupPercent} />
        {node.uncovered && (
          <span
            className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-bold text-orange-700 shrink-0"
            data-testid="uncovered-flag"
          >
            no spec/plan yet
          </span>
        )}
        {node.reconcileState === "parent_changed" && (
          <span
            className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 shrink-0"
            data-testid="reconcile-flag"
          >
            needs reconcile
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <PlanNodeRow key={child.id} node={child} depth={depth + 1} />
          ))}
          {node.issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} depth={depth + 1} isSub={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function DriftSection({ issues }: { issues: GrandPlanViewIssue[] }) {
  const [expanded, setExpanded] = useState(false);
  if (issues.length === 0) return null;

  return (
    <div
      className="mt-4 overflow-hidden rounded-lg border border-red-200"
      data-testid="drift-section"
    >
      <div
        className="flex items-center gap-2 bg-red-50 px-3 py-2 text-sm cursor-pointer"
        style={{ boxShadow: "inset 3px 0 0 #dc2626" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-600" />
        <span className="inline-flex items-center rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shrink-0">
          Drift
        </span>
        <span className="flex-1 truncate font-medium text-red-700">
          {issues.length} issue{issues.length === 1 ? "" : "s"} with no PRD component (cannot be traced)
        </span>
      </div>
      {expanded && (
        <div className="bg-background">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} depth={1} isSub={false} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GrandPlan() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Active plan" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery<GrandPlanView>({
    queryKey: queryKeys.grandPlan.view(selectedCompanyId!),
    queryFn: () => grandPlanApi.view(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTree} message="Select a company to view its grand plan." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }

  const hasPlan = Boolean(data?.tree);
  const driftIssues = data?.driftIssues ?? [];

  if (!hasPlan && driftIssues.length === 0) {
    return (
      <EmptyState
        icon={ListTree}
        message="No grand plan yet. Once a PRD is broken into components, its plan appears here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Active plan — Grand Plan</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The PRD is broken into components (each a clause). Every component anchors its own
          Spec &rarr; Plan &rarr; issue lineage. Anything that can&apos;t trace to a specific PRD
          component is flagged as drift.
        </p>
      </div>

      {data?.tree && (
        <div className="overflow-hidden rounded-lg border border-border py-1">
          {/* Render the PRD document root's clauses as collapsed top-level rows. */}
          {data.tree.children.map((clause) => (
            <PlanNodeRow key={clause.id} node={clause} depth={0} />
          ))}
        </div>
      )}

      <DriftSection issues={driftIssues} />
    </div>
  );
}
