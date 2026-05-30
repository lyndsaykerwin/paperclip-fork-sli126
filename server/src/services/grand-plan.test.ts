import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  projects,
  grandPlanNodes,
  documents,
  documentRevisions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { grandPlanService } from "./grand-plan.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres grand-plan service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("grandPlanService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof grandPlanService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let projectId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grand-plan-service-");
    db = createDb(tempDb.connectionString);
    svc = grandPlanService(db);
  }, 20_000);

  afterEach(async () => {
    // Delete in FK-safe order: issues ref grand_plan_nodes; grand_plan_nodes
    // ref companies/projects/documents/revisions.
    await db.delete(issues);
    await db.delete(grandPlanNodes);
    await db.delete(documentRevisions);
    await db.delete(documents);
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

  it("(a) create — inserts a prd root node with parentId null", async () => {
    await seedCompanyAndProject();

    const node = await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "My PRD",
    });

    expect(node.id).toBeTruthy();
    expect(node.companyId).toBe(companyId);
    expect(node.projectId).toBe(projectId);
    expect(node.parentId).toBeNull();
    expect(node.tier).toBe("prd");
    expect(node.title).toBe("My PRD");
    expect(node.reconcileState).toBe("current");
    expect(node.rollupPercent).toBe(0);
    expect(typeof node.createdAt).toBe("string");
    expect(typeof node.updatedAt).toBe("string");
  });

  it("(b) create — rejects a second prd root for the same company+project", async () => {
    await seedCompanyAndProject();

    await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "First PRD",
    });

    await expect(
      svc.create({
        companyId,
        projectId,
        parentId: null,
        tier: "prd",
        title: "Duplicate PRD",
      }),
    ).rejects.toThrow();
  });

  it("(c) getRoot — returns the prd root for a company+project", async () => {
    await seedCompanyAndProject();

    await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "Root PRD",
    });

    const root = await svc.getRoot(companyId, projectId);
    expect(root).not.toBeNull();
    expect(root!.tier).toBe("prd");
    expect(root!.parentId).toBeNull();
    expect(root!.title).toBe("Root PRD");
  });

  it("(d) getAncestors — returns [spec, prd] ordered nearest-parent-first for a plan node", async () => {
    await seedCompanyAndProject();

    const prd = await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "Root PRD",
    });

    const spec = await svc.create({
      companyId,
      projectId,
      parentId: prd.id,
      tier: "spec",
      title: "Spec Node",
    });

    const plan = await svc.create({
      companyId,
      projectId,
      parentId: spec.id,
      tier: "plan",
      title: "Plan Node",
    });

    const ancestors = await svc.getAncestors(plan.id);
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0]!.id).toBe(spec.id);
    expect(ancestors[1]!.id).toBe(prd.id);
  });

  it("(e) getTree — returns root with nested children", async () => {
    await seedCompanyAndProject();

    const prd = await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "Root PRD",
    });

    const spec = await svc.create({
      companyId,
      projectId,
      parentId: prd.id,
      tier: "spec",
      title: "Spec Node",
    });

    await svc.create({
      companyId,
      projectId,
      parentId: spec.id,
      tier: "plan",
      title: "Plan Node",
    });

    const tree = await svc.getTree(companyId, projectId);
    expect(tree).not.toBeNull();
    expect(tree!.id).toBe(prd.id);
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0]!.id).toBe(spec.id);
    expect(tree!.children[0]!.children).toHaveLength(1);
    expect(tree!.children[0]!.children[0]!.tier).toBe("plan");
  });

  it("(f) attachDocument — sets documentId and sourceRevisionId columns", async () => {
    await seedCompanyAndProject();

    const prd = await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "Root PRD",
    });

    // Create a real document and revision so FK constraints are satisfied
    const docId = randomUUID();
    await db.insert(documents).values({
      id: docId,
      companyId,
      latestBody: "Draft content",
    });

    const revId = randomUUID();
    await db.insert(documentRevisions).values({
      id: revId,
      companyId,
      documentId: docId,
      revisionNumber: 1,
      body: "Draft content",
    });

    const updated = await svc.attachDocument(prd.id, docId, revId);
    expect(updated.documentId).toBe(docId);
    expect(updated.sourceRevisionId).toBe(revId);
  });

  it("(g) getView — nests tethered issues + sub-issues, flags uncovered clauses, lists drift", async () => {
    await seedCompanyAndProject();

    // PRD document root
    const root = await svc.create({
      companyId,
      projectId,
      parentId: null,
      tier: "prd",
      title: "PRD document root",
    });

    // Clause 1 — covered: spec → plan → issue (+ sub-issue)
    const clause1 = await svc.create({
      companyId,
      projectId,
      parentId: root.id,
      tier: "prd",
      title: "Clause 1 — covered",
    });
    const spec1 = await svc.create({
      companyId,
      projectId,
      parentId: clause1.id,
      tier: "spec",
      title: "Spec for clause 1",
    });
    const plan1 = await svc.create({
      companyId,
      projectId,
      parentId: spec1.id,
      tier: "plan",
      title: "Plan for clause 1",
    });
    await svc.setRollupPercent(plan1.id, 60);

    // Clause 2 — uncovered: no spec/plan children
    const clause2 = await svc.create({
      companyId,
      projectId,
      parentId: root.id,
      tier: "prd",
      title: "Clause 2 — uncovered",
    });

    // Tethered issue on plan1 + its sub-issue
    const tetheredId = randomUUID();
    await db.insert(issues).values({
      id: tetheredId,
      companyId,
      projectId,
      grandPlanNodeId: plan1.id,
      title: "Tethered issue",
      status: "in_progress",
      identifier: "T-1",
    });
    const subIssueId = randomUUID();
    await db.insert(issues).values({
      id: subIssueId,
      companyId,
      projectId,
      parentId: tetheredId,
      grandPlanNodeId: plan1.id,
      title: "Sub-issue",
      status: "done",
      identifier: "T-1.1",
    });

    // Drift issue — no grandPlanNodeId at all
    const driftId = randomUUID();
    await db.insert(issues).values({
      id: driftId,
      companyId,
      title: "Orphan drift issue",
      status: "todo",
      identifier: "D-1",
    });

    const view = await svc.getView(companyId, projectId);
    expect(view.tree).not.toBeNull();
    expect(view.tree!.id).toBe(root.id);

    const viewClause1 = view.tree!.children.find((c) => c.id === clause1.id)!;
    const viewClause2 = view.tree!.children.find((c) => c.id === clause2.id)!;
    expect(viewClause1).toBeTruthy();
    expect(viewClause2).toBeTruthy();

    // covered clause is not flagged uncovered; uncovered clause is
    expect(viewClause1.uncovered).toBe(false);
    expect(viewClause2.uncovered).toBe(true);

    // tethered issue lives on the plan node and carries its sub-issue nested
    const viewPlan = viewClause1.children[0]!.children[0]!;
    expect(viewPlan.tier).toBe("plan");
    expect(viewPlan.rollupPercent).toBe(60);
    expect(viewPlan.issues).toHaveLength(1);
    expect(viewPlan.issues[0]!.id).toBe(tetheredId);
    expect(viewPlan.issues[0]!.children).toHaveLength(1);
    expect(viewPlan.issues[0]!.children[0]!.id).toBe(subIssueId);

    // the sub-issue is NOT separately listed as a top-level tethered issue
    const allTopLevelIds = viewPlan.issues.map((i) => i.id);
    expect(allTopLevelIds).not.toContain(subIssueId);

    // drift list contains the orphan and nothing tethered
    const driftIds = view.driftIssues.map((i) => i.id);
    expect(driftIds).toContain(driftId);
    expect(driftIds).not.toContain(tetheredId);
    expect(driftIds).not.toContain(subIssueId);
  });

  it("(h) getView — returns null tree + drift list when no grand plan exists", async () => {
    await seedCompanyAndProject();

    const driftId = randomUUID();
    await db.insert(issues).values({
      id: driftId,
      companyId,
      title: "Issue with no plan at all",
      status: "todo",
      identifier: "D-2",
    });

    const view = await svc.getView(companyId, projectId);
    expect(view.tree).toBeNull();
    expect(view.driftIssues.map((i) => i.id)).toContain(driftId);
  });
});
