import { useMatch } from "@/lib/router";

export function useActiveIssueId(): string | null {
  const match = useMatch("/:companyPrefix/issues/:issueId");
  return match?.params.issueId ?? null;
}
