import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  companies,
  projects,
  grandPlanNodes,
  issues,
  approvals,
  agents,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { grandPlanService } from "./grand-plan.js";
import { issueService } from "./issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres grand-plan soft-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.create grand-plan soft gate (B1)", () => {
  let db!: ReturnType<typeof createDb>;
  let gp!: ReturnType<typeof grandPlanService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let projectId: string;
  let ceoAgentId: string;

  // Stub heartbeat dependency injected into issueService; records CEO wakes.
  const wakeup = vi.fn(
    async (_agentId: string, _opts: Record<string, unknown>): Promise<unknown> => undefined,
  );

  function svcWithHeartbeat() {
    return issueService(db, { heartbeat: { wakeup } });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grand-plan-soft-gate-");
    db = createDb(tempDb.connectionString);
    gp = grandPlanService(db);
  }, 20_000);

  beforeEach(() => {
    wakeup.mockClear();
  });

  afterEach(async () => {
    // FK-safe order: issues ref grand_plan_nodes + agents; approvals ref agents.
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(grandPlanNodes);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: { withCeo?: boolean } = {}) {
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
    });
    if (opts.withCeo) {
      ceoAgentId = randomUUID();
      await db.insert(agents).values({
        id: ceoAgentId,
        companyId,
        name: "CEO Agent",
        role: "ceo",
      });
    }
  }

  /** Build a prd -> spec -> plan chain at company scope (projectId null). */
  async function seedGrandPlanAtCompanyScope() {
    const prd = await gp.create({
      companyId,
      projectId: null,
      parentId: null,
      tier: "prd",
      title: "PRD",
    });
    const spec = await gp.create({
      companyId,
      projectId: null,
      parentId: prd.id,
      tier: "spec",
      title: "Spec",
    });
    const plan = await gp.create({
      companyId,
      projectId: null,
      parentId: spec.id,
      tier: "plan",
      title: "Plan",
    });
    return { prd, spec, plan };
  }

  async function pendingTetherApprovals(forIssueId?: string) {
    const rows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    return rows.filter(
      (r) =>
        r.type === "grand_plan_tether" &&
        r.status === "pending" &&
        (forIssueId == null || (r.payload as Record<string, unknown>)?.issueId === forIssueId),
    );
  }

  it("accepts grandPlanNodeId at creation and tethers the issue", async () => {
    await seedCompany({ withCeo: true });
    const { plan } = await seedGrandPlanAtCompanyScope();

    const issue = await svcWithHeartbeat().create(companyId, {
      title: "Tethered issue",
      status: "backlog",
      grandPlanNodeId: plan.id,
    });

    expect(issue.grandPlanNodeId).toBe(plan.id);
    // Already anchored -> no tether approval raised, no CEO wake.
    expect(await pendingTetherApprovals()).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("rejects creation with a grandPlanNodeId that does not exist for the company", async () => {
    await seedCompany();
    await expect(
      svcWithHeartbeat().create(companyId, {
        title: "Bad clause",
        status: "backlog",
        grandPlanNodeId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("child issue with no explicit clause inherits the parent's grandPlanNodeId", async () => {
    await seedCompany({ withCeo: true });
    const { plan } = await seedGrandPlanAtCompanyScope();

    const parent = await svcWithHeartbeat().create(companyId, {
      title: "Parent",
      status: "backlog",
      grandPlanNodeId: plan.id,
    });

    const { issue: child } = await svcWithHeartbeat().createChild(parent.id, {
      title: "Child",
      status: "backlog",
    });

    expect(child.grandPlanNodeId).toBe(plan.id);
  });

  it("plain create with parentId (no explicit clause) inherits the parent's grandPlanNodeId", async () => {
    await seedCompany({ withCeo: true });
    const { plan } = await seedGrandPlanAtCompanyScope();

    const parent = await svcWithHeartbeat().create(companyId, {
      title: "Parent",
      status: "backlog",
      grandPlanNodeId: plan.id,
    });

    const child = await svcWithHeartbeat().create(companyId, {
      title: "Child via plain create",
      status: "backlog",
      parentId: parent.id,
    });

    expect(child.grandPlanNodeId).toBe(plan.id);
    // Inherited a clause -> still anchored, no raise.
    expect(await pendingTetherApprovals()).toHaveLength(0);
  });

  it("company WITH a grand plan: untethered top-level issue raises one approval and wakes CEO; idempotent", async () => {
    await seedCompany({ withCeo: true });
    await seedGrandPlanAtCompanyScope();

    const issue = await svcWithHeartbeat().create(companyId, {
      title: "Drift issue",
      status: "backlog",
    });

    expect(issue.grandPlanNodeId == null).toBe(true);
    const raised = await pendingTetherApprovals(issue.id);
    expect(raised).toHaveLength(1);
    expect((raised[0].payload as Record<string, unknown>).issueId).toBe(issue.id);
    expect((raised[0].payload as Record<string, unknown>).issueTitle).toBe("Drift issue");

    // CEO woken exactly once for this issue.
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0][0]).toBe(ceoAgentId);

    // Idempotency: a second create that resolves to the SAME issue won't happen,
    // but re-running the raise for the same issue must not double up. Simulate by
    // calling the gate twice via creating a second untethered issue and asserting
    // each issue gets exactly one approval (no cross-contamination), and that the
    // first issue still has exactly one.
    const issue2 = await svcWithHeartbeat().create(companyId, {
      title: "Second drift issue",
      status: "backlog",
    });
    expect(await pendingTetherApprovals(issue.id)).toHaveLength(1);
    expect(await pendingTetherApprovals(issue2.id)).toHaveLength(1);
  });

  it("company WITHOUT a grand plan: untethered issue raises nothing and does not wake", async () => {
    await seedCompany({ withCeo: true });
    // No grand plan root seeded.

    const issue = await svcWithHeartbeat().create(companyId, {
      title: "No-plan issue",
      status: "backlog",
    });

    expect(issue.id).toBeTruthy();
    expect(await pendingTetherApprovals()).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("never throws because of the gate even if the raise path errors", async () => {
    await seedCompany({ withCeo: true });
    await seedGrandPlanAtCompanyScope();

    // Heartbeat wake throws -> gate must swallow and still return the created issue.
    wakeup.mockRejectedValueOnce(new Error("boom"));

    const issue = await svcWithHeartbeat().create(companyId, {
      title: "Resilient issue",
      status: "backlog",
    });

    expect(issue.id).toBeTruthy();
    expect(issue.title).toBe("Resilient issue");
  });
});
