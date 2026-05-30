import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvalComments, approvals, grandPlanNodes } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { grandPlanService } from "./grand-plan.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Optional dependencies for the approval service. B2 (the Grand Plan PRD-change
 * cascade) injects a heartbeat so an approved `grand_plan_reconcile` can wake the
 * company CEO to author the ripple work. All optional, so existing
 * `approvalService(db)` callers keep working unchanged.
 */
export interface ApprovalServiceDeps {
  heartbeat?: {
    wakeup: (
      agentId: string,
      opts: {
        source?: "timer" | "assignment" | "on_demand" | "automation";
        triggerDetail?: "manual" | "ping" | "callback" | "system";
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  };
}

export function approvalService(db: Db, deps: ApprovalServiceDeps = {}) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const grandPlan = grandPlanService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  /**
   * B2 — apply the side-effects of an approved `grand_plan_reconcile`:
   *   - for each `added` clause ID: ensure a clause HEADER node exists under the
   *     doc-root (create if missing — idempotent). Never authors content.
   *   - for each `changed` clause ID: clear the flag on that clause node + every
   *     descendant back to `reconcileState='current'` (owner approved the change).
   *   - `removed` clauses: do NOTHING — leave them flagged, never auto-delete.
   *   - wake the company CEO so it authors the actual ripple work.
   * Best-effort: a failure here only warns; the approval still resolves.
   */
  async function applyGrandPlanReconcile(approval: ApprovalRecord): Promise<void> {
    try {
      const payload = approval.payload as Record<string, unknown>;
      const documentId = typeof payload.documentId === "string" ? payload.documentId : null;
      const added = Array.isArray(payload.added) ? (payload.added as string[]) : [];
      const changed = Array.isArray(payload.changed) ? (payload.changed as string[]) : [];

      // Resolve the doc-root: prefer the node attached to the payload documentId,
      // else fall back to the company's prd root.
      let root = null as Awaited<ReturnType<typeof grandPlan.getRoot>>;
      if (documentId) {
        const attached = await db
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
        if (attached) root = await grandPlan.getById(attached.id);
      }
      if (!root) root = await grandPlan.getRoot(approval.companyId, null);
      if (!root) return;

      // Existing clause nodes under the doc root, by title.
      const clauseRows = await db
        .select()
        .from(grandPlanNodes)
        .where(and(eq(grandPlanNodes.companyId, root.companyId), eq(grandPlanNodes.parentId, root.id)));
      const clauseByTitle = new Map(clauseRows.map((n) => [n.title, n]));

      // added -> ensure clause header node exists (idempotent).
      for (const clauseId of added) {
        if (clauseByTitle.has(clauseId)) continue;
        const node = await grandPlan.create({
          companyId: root.companyId,
          projectId: root.projectId ?? null,
          parentId: root.id,
          tier: "prd",
          title: clauseId,
        });
        clauseByTitle.set(clauseId, node as unknown as (typeof clauseRows)[number]);
      }

      // changed -> clear the clause node + descendants back to "current".
      for (const clauseId of changed) {
        const node = clauseByTitle.get(clauseId);
        if (!node) continue;
        await grandPlan.setReconcileState(node.id, "current");
        const descendants = await grandPlan.getDescendants(node.id);
        for (const d of descendants) await grandPlan.setReconcileState(d.id, "current");
      }

      // removed -> intentionally untouched (flag-only policy).

      // Wake the CEO to author the ripple work.
      if (deps.heartbeat) {
        const ceo = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, root.companyId), eq(agents.role, "ceo")))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (ceo) {
          await deps.heartbeat.wakeup(ceo.id, {
            source: "automation",
            triggerDetail: "system",
            reason: "grand_plan_reconcile",
            payload: {
              approvalId: approval.id,
              documentId,
              added,
              changed,
              removed: Array.isArray(payload.removed) ? payload.removed : [],
              mutation: "reconcile_approved",
            },
            requestedByActorType: "system",
            requestedByActorId: null,
            contextSnapshot: { approvalId: approval.id, source: "approval.grand_plan_reconcile" },
          });
        }
      }
    } catch (err) {
      logger.warn(
        { err, approvalId: approval.id },
        "grand_plan_reconcile approve side-effects failed; approval still resolved",
      );
    }
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      if (applied && updated.type === "grand_plan_reconcile") {
        await applyGrandPlanReconcile(updated);
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
