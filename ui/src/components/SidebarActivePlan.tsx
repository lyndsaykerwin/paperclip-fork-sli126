import { FileText } from "lucide-react";
import { NavLink } from "@/lib/router";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";

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
  const { selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();

  // Graceful muted state until a company is selected.
  if (!selectedCompanyId) {
    return <MutedEntry label="Active plan" />;
  }

  return (
    <NavLink
      to="/grand-plan"
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
