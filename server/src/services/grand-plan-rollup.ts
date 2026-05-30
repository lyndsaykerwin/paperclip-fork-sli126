import { count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { grandPlanNodes, issues } from "@paperclipai/db";

/**
 * Recompute a single node's rollupPercent from the issues tethered anywhere in
 * its subtree (the node itself plus all descendant nodes).
 *
 * Formula:
 *   rollupPercent = round(100 * doneCount / totalCount)
 * where totalCount = issues with grandPlanNodeId in {node, ...descendants}
 * and   doneCount  = those whose status === "done".
 * Zero tethered issues in the subtree => rollupPercent = 0.
 *
 * Runs entirely on the provided handle (typically a transaction `tx`) so the
 * write participates in the caller's transaction.
 */
async function recomputeNodeRollup(tx: Db, nodeId: string): Promise<void> {
  // Collect the subtree node ids: the node itself plus all descendants.
  const subtreeIds = new Set<string>([nodeId]);
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = await tx
      .select({ id: grandPlanNodes.id })
      .from(grandPlanNodes)
      .where(eq(grandPlanNodes.parentId, currentId));
    for (const child of children) {
      if (!subtreeIds.has(child.id)) {
        subtreeIds.add(child.id);
        queue.push(child.id);
      }
    }
  }

  const ids = [...subtreeIds];

  const [totals] = await tx
    .select({
      total: count(),
      done: sql<number>`count(*) filter (where ${issues.status} = 'done')`,
    })
    .from(issues)
    .where(inArray(issues.grandPlanNodeId, ids));

  const total = Number(totals?.total ?? 0);
  const done = Number(totals?.done ?? 0);
  const percent = total === 0 ? 0 : Math.round((100 * done) / total);

  await tx
    .update(grandPlanNodes)
    .set({ rollupPercent: percent, updatedAt: new Date() })
    .where(eq(grandPlanNodes.id, nodeId));
}

/**
 * Recompute the rollupPercent for `nodeId` and then for each of its ancestors,
 * walking parentId up to the root. All writes run on `tx`.
 */
export async function recomputeGrandPlanRollupForNodeAndAncestors(
  tx: Db,
  nodeId: string,
): Promise<void> {
  // Recompute the node itself.
  await recomputeNodeRollup(tx, nodeId);

  // Walk ancestors (parentId chain) and recompute each.
  let currentId: string | null = nodeId;
  while (currentId != null) {
    const rows = await tx
      .select({ parentId: grandPlanNodes.parentId })
      .from(grandPlanNodes)
      .where(eq(grandPlanNodes.id, currentId));
    const parentId: string | null = rows[0]?.parentId ?? null;
    if (parentId == null) break;
    await recomputeNodeRollup(tx, parentId);
    currentId = parentId;
  }
}
