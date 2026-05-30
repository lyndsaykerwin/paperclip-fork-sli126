import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  createDb,
  documentRevisions,
  documents,
  grandPlanNodes,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { grandPlanService } from "./grand-plan.js";
import { approvalService } from "./approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approvals grand_plan_reconcile tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("approvalService.approve grand_plan_reconcile branch (B2)", () => {
  let db!: ReturnType<typeof createDb>;
  let gp!: ReturnType<typeof grandPlanService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let ceoAgentId: string;
  const userId = "00000000-0000-0000-0000-000000000abc";

  const wakeup = vi.fn(
    async (_agentId: string, _opts: Record<string, unknown>): Promise<unknown> => undefined,
  );

  function svc() {
    return approvalService(db, { heartbeat: { wakeup } });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approvals-reconcile-");
    db = createDb(tempDb.connectionString);
    gp = grandPlanService(db);
  }, 20_000);

  beforeEach(() => {
    wakeup.mockClear();
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(grandPlanNodes);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agents);
    await db.delete(companies);
  });

  /** Insert a minimal document row so attachDocument's FK is satisfied. */
  async function seedDocument(): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({
        companyId,
        title: "PRD",
        format: "markdown",
        latestBody: "## PRD-story-1\nAlpha.",
        latestRevisionNumber: 1,
      })
      .returning();
    return doc.id;
  }

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    ceoAgentId = randomUUID();
    await db.insert(agents).values({
      id: ceoAgentId,
      companyId,
      name: "CEO Agent",
      role: "ceo",
    });
  }

  it("on approve: creates added-clause nodes, clears changed subtree, leaves removed flagged, wakes CEO", async () => {
    await seedCompany();
    const documentId = await seedDocument();

    // doc root attached to documentId
    const root = await gp.create({
      companyId,
      projectId: null,
      parentId: null,
      tier: "prd",
      title: "PRD root",
    });
    await gp.attachDocument(root.id, documentId, null);

    // changed clause node + a flagged spec descendant
    const changedClause = await gp.create({
      companyId,
      projectId: null,
      parentId: root.id,
      tier: "prd",
      title: "PRD-story-1",
    });
    const changedSpec = await gp.create({
      companyId,
      projectId: null,
      parentId: changedClause.id,
      tier: "spec",
      title: "Spec 1",
    });
    await gp.setReconcileState(changedClause.id, "parent_changed");
    await gp.setReconcileState(changedSpec.id, "parent_changed");

    // removed clause node, flagged
    const removedClause = await gp.create({
      companyId,
      projectId: null,
      parentId: root.id,
      tier: "prd",
      title: "PRD-story-2",
    });
    await gp.setReconcileState(removedClause.id, "parent_changed");

    // pending reconcile approval
    const approval = await svc().create(companyId, {
      type: "grand_plan_reconcile",
      status: "pending",
      payload: {
        documentId,
        fromRevisionId: null,
        toRevisionId: null,
        added: ["PRD-story-3"],
        changed: ["PRD-story-1"],
        removed: ["PRD-story-2"],
        affectedClauseNodeIds: [changedClause.id, removedClause.id],
        affectedIssueCount: 0,
      },
    });

    const { applied } = await svc().approve(approval!.id, userId, "looks good");
    expect(applied).toBe(true);

    // added clause -> new clause node created under root
    const allNodes = await db
      .select()
      .from(grandPlanNodes)
      .where(eq(grandPlanNodes.companyId, companyId));
    const added = allNodes.find((n) => n.title === "PRD-story-3" && n.parentId === root.id);
    expect(added).toBeTruthy();
    expect(added?.tier).toBe("prd");

    // changed clause + its descendant cleared to current
    expect((await gp.getById(changedClause.id))?.reconcileState).toBe("current");
    expect((await gp.getById(changedSpec.id))?.reconcileState).toBe("current");

    // removed clause LEFT flagged, never deleted
    const removedAfter = await gp.getById(removedClause.id);
    expect(removedAfter).not.toBeNull();
    expect(removedAfter?.reconcileState).toBe("parent_changed");

    // CEO woken
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0][0]).toBe(ceoAgentId);
  });

  it("added-clause creation is idempotent (does not duplicate an existing clause node)", async () => {
    await seedCompany();
    const documentId = await seedDocument();
    const root = await gp.create({
      companyId,
      projectId: null,
      parentId: null,
      tier: "prd",
      title: "PRD root",
    });
    await gp.attachDocument(root.id, documentId, null);
    // PRD-story-9 already exists.
    await gp.create({
      companyId,
      projectId: null,
      parentId: root.id,
      tier: "prd",
      title: "PRD-story-9",
    });

    const approval = await svc().create(companyId, {
      type: "grand_plan_reconcile",
      status: "pending",
      payload: {
        documentId,
        added: ["PRD-story-9"],
        changed: [],
        removed: [],
        affectedClauseNodeIds: [],
        affectedIssueCount: 0,
      },
    });
    await svc().approve(approval!.id, userId);

    const story9Nodes = (
      await db.select().from(grandPlanNodes).where(eq(grandPlanNodes.companyId, companyId))
    ).filter((n) => n.title === "PRD-story-9");
    expect(story9Nodes).toHaveLength(1);
  });

  it("a side-effect failure does not block the approval from resolving", async () => {
    await seedCompany();
    const documentId = await seedDocument();
    const root = await gp.create({
      companyId,
      projectId: null,
      parentId: null,
      tier: "prd",
      title: "PRD root",
    });
    await gp.attachDocument(root.id, documentId, null);

    const approval = await svc().create(companyId, {
      type: "grand_plan_reconcile",
      status: "pending",
      payload: {
        documentId,
        added: ["PRD-story-1"],
        changed: [],
        removed: [],
        affectedClauseNodeIds: [],
        affectedIssueCount: 0,
      },
    });

    // wake throws -> approval still resolves to approved.
    wakeup.mockRejectedValueOnce(new Error("boom"));
    const { applied } = await svc().approve(approval!.id, userId);
    expect(applied).toBe(true);
    const row = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval!.id))
      .then((r) => r[0]);
    expect(row.status).toBe("approved");
  });

  it("existing approvalService(db) callers (no deps) still work for non-reconcile approvals", async () => {
    await seedCompany();
    const approval = await approvalService(db).create(companyId, {
      type: "some_other_type",
      status: "pending",
      payload: {},
    });
    const { applied } = await approvalService(db).approve(approval!.id, userId);
    expect(applied).toBe(true);
  });
});
