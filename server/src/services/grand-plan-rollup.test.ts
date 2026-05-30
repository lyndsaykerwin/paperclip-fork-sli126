import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  projects,
  grandPlanNodes,
  issues,
} from "@paperclipai/db";
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
    `Skipping embedded Postgres grand-plan rollup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("grand-plan rollup on issue done/un-done", () => {
  let db!: ReturnType<typeof createDb>;
  let gp!: ReturnType<typeof grandPlanService>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let projectId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grand-plan-rollup-");
    db = createDb(tempDb.connectionString);
    gp = grandPlanService(db);
    issuesSvc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    // FK-safe order: issues ref grand_plan_nodes; grand_plan_nodes ref companies/projects.
    await db.delete(issues);
    await db.delete(grandPlanNodes);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndProject() {
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
  }

  /** Build a prd -> spec -> plan chain. Returns the three node ids. */
  async function seedPrdSpecPlan() {
    const prd = await gp.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "PRD",
    });
    const spec = await gp.create({
      companyId,
      projectId,
      parentId: prd.id,
      tier: "spec",
      title: "Spec",
    });
    const plan = await gp.create({
      companyId,
      projectId,
      parentId: spec.id,
      tier: "plan",
      title: "Plan",
    });
    return { prd, spec, plan };
  }

  /** Insert an issue tethered to a grand plan node. Returns its id. */
  async function seedIssue(grandPlanNodeId: string | null, status = "in_review") {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      projectId,
      grandPlanNodeId,
      title: "Issue",
      status,
    });
    return id;
  }

  async function rollup(nodeId: string): Promise<number> {
    const node = await gp.getById(nodeId);
    if (!node) throw new Error(`node not found: ${nodeId}`);
    return node.rollupPercent;
  }

  it("completing the only issue under a plan node ticks plan -> spec -> prd to 100", async () => {
    await seedCompanyAndProject();
    const { prd, spec, plan } = await seedPrdSpecPlan();
    const issueId = await seedIssue(plan.id, "in_review");

    // Precondition: nothing done yet.
    expect(await rollup(plan.id)).toBe(0);
    expect(await rollup(spec.id)).toBe(0);
    expect(await rollup(prd.id)).toBe(0);

    await issuesSvc.update(issueId, { status: "done" });

    expect(await rollup(plan.id)).toBe(100);
    expect(await rollup(spec.id)).toBe(100);
    expect(await rollup(prd.id)).toBe(100);
  });

  it("partial completion (1 of 2 done) yields 50 up the chain", async () => {
    await seedCompanyAndProject();
    const { prd, spec, plan } = await seedPrdSpecPlan();
    const issueA = await seedIssue(plan.id, "in_review");
    await seedIssue(plan.id, "in_review"); // second issue, stays not-done

    await issuesSvc.update(issueA, { status: "done" });

    expect(await rollup(plan.id)).toBe(50);
    expect(await rollup(spec.id)).toBe(50);
    expect(await rollup(prd.id)).toBe(50);
  });

  it("reverting a done issue recomputes the chain downward", async () => {
    await seedCompanyAndProject();
    const { prd, spec, plan } = await seedPrdSpecPlan();
    const issueId = await seedIssue(plan.id, "in_review");

    await issuesSvc.update(issueId, { status: "done" });
    expect(await rollup(plan.id)).toBe(100);
    expect(await rollup(prd.id)).toBe(100);

    // Move it back out of done.
    await issuesSvc.update(issueId, { status: "in_review" });

    expect(await rollup(plan.id)).toBe(0);
    expect(await rollup(spec.id)).toBe(0);
    expect(await rollup(prd.id)).toBe(0);
  });

  it("aggregates issues tethered to different nodes in the subtree", async () => {
    await seedCompanyAndProject();
    const { prd, spec, plan } = await seedPrdSpecPlan();
    // One issue on the spec node, one on the plan node.
    const onSpec = await seedIssue(spec.id, "in_review");
    const onPlan = await seedIssue(plan.id, "in_review");

    await issuesSvc.update(onPlan, { status: "done" });
    // prd subtree: 2 tethered, 1 done -> 50; spec subtree: 2 tethered, 1 done -> 50;
    // plan subtree: 1 tethered, 1 done -> 100.
    expect(await rollup(plan.id)).toBe(100);
    expect(await rollup(spec.id)).toBe(50);
    expect(await rollup(prd.id)).toBe(50);

    await issuesSvc.update(onSpec, { status: "done" });
    expect(await rollup(spec.id)).toBe(100);
    expect(await rollup(prd.id)).toBe(100);
  });

  it("is inert for an issue with no grand plan node (null tether)", async () => {
    await seedCompanyAndProject();
    const { prd, spec, plan } = await seedPrdSpecPlan();
    const untethered = await seedIssue(null, "in_review");

    await issuesSvc.update(untethered, { status: "done" });

    // No node should have changed.
    expect(await rollup(plan.id)).toBe(0);
    expect(await rollup(spec.id)).toBe(0);
    expect(await rollup(prd.id)).toBe(0);
  });
});
