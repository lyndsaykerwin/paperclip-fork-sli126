import { FileText } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useActiveIssueId } from "../hooks/useActiveIssueId";
import { useSidebar } from "../context/SidebarContext";
import { getIssueDetailQueryOptions } from "../lib/issueDetailCache";

const PLAN_DOCUMENT_KEY = "plan";

function MutedEntry({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground/60 cursor-default select-none"
      aria-disabled="true"
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
    </div>
  );
}

export function SidebarActivePlan() {
  const activeIssueId = useActiveIssueId();
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen } = useSidebar();

  const documentsQuery = useQuery({
    queryKey: activeIssueId
      ? queryKeys.issues.documents(activeIssueId)
      : ["issues", "documents", "__none__"],
    queryFn: () => issuesApi.listDocuments(activeIssueId!),
    enabled: !!activeIssueId,
    staleTime: 5_000,
  });

  const issueDetailQuery = useQuery({
    ...getIssueDetailQueryOptions(queryClient, activeIssueId ?? "__none__"),
    enabled: !!activeIssueId,
    staleTime: 5_000,
  });

  if (!activeIssueId) {
    return <MutedEntry label="No active plan" />;
  }

  const planDoc = documentsQuery.data?.find((doc) => doc.key === PLAN_DOCUMENT_KEY);
  const legacyPlan = issueDetailQuery.data?.legacyPlanDocument ?? null;
  const hasPlan = Boolean(planDoc) || Boolean(legacyPlan);

  if (documentsQuery.isLoading && issueDetailQuery.isLoading && !documentsQuery.data && !issueDetailQuery.data) {
    return <MutedEntry label="Active plan" />;
  }

  if (!hasPlan) {
    return <MutedEntry label="No active plan" />;
  }

  return (
    <NavLink
      to={`/issues/${activeIssueId}#document-plan`}
      state={SIDEBAR_SCROLL_RESET_STATE}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        )
      }
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">Active plan</span>
    </NavLink>
  );
}
