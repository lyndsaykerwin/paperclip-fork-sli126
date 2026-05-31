import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

/**
 * Resolve the agent id of a company's CEO — the agent the Grand Plan governance
 * flows wake (unrouted issues, PRD-change reconciles).
 *
 * Identification, in priority order:
 *   1. An agent explicitly roled `"ceo"` (the standard Paperclip convention).
 *   2. The org root — the agent that reports to nobody (`reportsTo IS NULL`).
 *      Some companies (e.g. SlideForge) created their CEO with role `"agent"`
 *      and only the org structure + title marks it as CEO; a role-only lookup
 *      silently matched nobody, so those wakes were no-ops. When several roots
 *      exist, prefer one whose name/title reads as CEO.
 *
 * Returns null when no agent can be resolved (e.g. an empty company).
 */
export async function findCompanyCeoAgentId(db: Db, companyId: string): Promise<string | null> {
  const byRole = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (byRole) return byRole.id;

  const roots = await db
    .select({ id: agents.id, name: agents.name, title: agents.title })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.reportsTo)));
  if (roots.length === 0) return null;

  const looksCeo = roots.find(
    (r) => /\bceo\b|chief executive/i.test(r.name ?? "") || /chief executive/i.test(r.title ?? ""),
  );
  return (looksCeo ?? roots[0]).id;
}
