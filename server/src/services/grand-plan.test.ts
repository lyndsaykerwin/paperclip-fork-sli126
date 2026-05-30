import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  projects,
  grandPlanNodes,
  documents,
  documentRevisions,
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
    // Delete in FK-safe order: grand_plan_nodes refs companies/projects/documents/revisions
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
});
