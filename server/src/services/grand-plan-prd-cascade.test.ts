import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { grandPlanService } from "./grand-plan.js";
import { runPrdChangeCascade } from "./grand-plan-prd-cascade.js";
import { approvalService } from "./approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres grand-plan PRD-cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PRD-change cascade (B2)", () => {
  let db!: ReturnType<typeof createDb>;
  let gp!: ReturnType<typeof grandPlanService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId: string;
  let ceoAgentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grand-plan-prd-cascade-");
    db = createDb(tempDb.connectionString);
    gp = grandPlanService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(grandPlanNodes);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: { withCeo?: boolean } = {}) {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

  /** Insert a document + initial revision, return ids. */
  async function seedDocument(body: string): Promise<{ documentId: string; revisionId: string }> {
    const [doc] = await db
      .insert(documents)
      .values({
        companyId,
        title: "PRD",
        format: "markdown",
        latestBody: body,
        latestRevisionNumber: 1,
      })
      .returning();
    const [rev] = await db
      .insert(documentRevisions)
      .values({
        companyId,
        documentId: doc.id,
        revisionNumber: 1,
        format: "markdown",
        body,
      })
      .returning();
    await db.update(documents).set({ latestRevisionId: rev.id }).where(eq(documents.id, doc.id));
    return { documentId: doc.id, revisionId: rev.id };
  }

  /** Insert a new revision row, return its id. */
  async function addRevision(documentId: string, body: string, n: number): Promise<string> {
    const [rev] = await db
      .insert(documentRevisions)
      .values({ companyId, documentId, revisionNumber: n, format: "markdown", body })
      .returning();
    await db
      .update(documents)
      .set({ latestBody: body, latestRevisionId: rev.id, latestRevisionNumber: n })
      .where(eq(documents.id, documentId));
    return rev.id;
  }

  /**
   * Seed a doc-root node attached to `documentId`, plus a clause node per
   * clauseId, plus one spec child + one issue tethered to that spec for the
   * first clause so we can verify descendant flagging.
   */
  async function seedGrandPlan(documentId: string, clauseIds: string[]) {
    const root = await gp.create({
      companyId,
      projectId: null,
      parentId: null,
      tier: "prd",
      title: "PRD root",
    });
    await gp.attachDocument(root.id, documentId, null);
    const clauseNodes: Record<string, string> = {};
    for (const c of clauseIds) {
      const node = await gp.create({
        companyId,
        projectId: null,
        parentId: root.id,
        tier: "prd",
        title: c,
      });
      clauseNodes[c] = node.id;
    }
    return { rootId: root.id, clauseNodes };
  }

  async function reconcileApprovalsFor(documentId: string) {
    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    return rows.filter(
      (r) =>
        r.type === "grand_plan_reconcile" &&
        (r.payload as Record<string, unknown>)?.documentId === documentId,
    );
  }

  it("flags the changed clause node + its descendants and raises exactly one approval", async () => {
    await seedCompany({ withCeo: true });
    const oldBody = "## PRD-story-1\nAlpha.\n## PRD-story-2\nBeta.";
    const { documentId, revisionId: fromRev } = await seedDocument(oldBody);
    const { clauseNodes } = await seedGrandPlan(documentId, ["PRD-story-1", "PRD-story-2"]);

    // Add a spec descendant + tethered issue under PRD-story-1.
    const spec = await gp.create({
      companyId,
      projectId: null,
      parentId: clauseNodes["PRD-story-1"],
      tier: "spec",
      title: "Spec 1",
    });
    const [iss] = await db
      .insert(issues)
      .values({ companyId, title: "Tethered", status: "backlog", grandPlanNodeId: spec.id })
      .returning();

    const newBody = "## PRD-story-1\nAlpha CHANGED.\n## PRD-story-2\nBeta.";
    const toRev = await addRevision(documentId, newBody, 2);

    await runPrdChangeCascade(db, {}, {
      documentId,
      companyId,
      oldBody,
      newBody,
      fromRevisionId: fromRev,
      toRevisionId: toRev,
    });

    // Clause-1 node + spec descendant flagged; clause-2 untouched.
    const clause1 = await gp.getById(clauseNodes["PRD-story-1"]);
    const clause2 = await gp.getById(clauseNodes["PRD-story-2"]);
    const specNode = await gp.getById(spec.id);
    expect(clause1?.reconcileState).toBe("parent_changed");
    expect(specNode?.reconcileState).toBe("parent_changed");
    expect(clause2?.reconcileState).toBe("current");

    const raised = await reconcileApprovalsFor(documentId);
    expect(raised).toHaveLength(1);
    const payload = raised[0].payload as Record<string, unknown>;
    expect(payload.changed).toEqual(["PRD-story-1"]);
    expect(payload.added).toEqual([]);
    expect(payload.removed).toEqual([]);
    expect(payload.fromRevisionId).toBe(fromRev);
    expect(payload.toRevisionId).toBe(toRev);
    expect(payload.affectedClauseNodeIds).toContain(clauseNodes["PRD-story-1"]);
    expect(payload.affectedIssueCount).toBe(1);
    void iss;
  });

  it("does nothing for a document with no grand-plan doc-root", async () => {
    await seedCompany({ withCeo: true });
    const oldBody = "## PRD-story-1\nAlpha.";
    const { documentId, revisionId: fromRev } = await seedDocument(oldBody);
    // No grand plan seeded for this document.
    const newBody = "## PRD-story-1\nAlpha CHANGED.";
    const toRev = await addRevision(documentId, newBody, 2);

    await runPrdChangeCascade(db, {}, {
      documentId,
      companyId,
      oldBody,
      newBody,
      fromRevisionId: fromRev,
      toRevisionId: toRev,
    });

    expect(await reconcileApprovalsFor(documentId)).toHaveLength(0);
  });

  it("is idempotent: a second edit while a pending reconcile exists does not double-raise", async () => {
    await seedCompany({ withCeo: true });
    const oldBody = "## PRD-story-1\nAlpha.";
    const { documentId, revisionId: fromRev } = await seedDocument(oldBody);
    await seedGrandPlan(documentId, ["PRD-story-1"]);

    const body2 = "## PRD-story-1\nAlpha v2.";
    const rev2 = await addRevision(documentId, body2, 2);
    await runPrdChangeCascade(db, {}, {
      documentId,
      companyId,
      oldBody,
      newBody: body2,
      fromRevisionId: fromRev,
      toRevisionId: rev2,
    });

    const body3 = "## PRD-story-1\nAlpha v3.";
    const rev3 = await addRevision(documentId, body3, 3);
    await runPrdChangeCascade(db, {}, {
      documentId,
      companyId,
      oldBody: body2,
      newBody: body3,
      fromRevisionId: rev2,
      toRevisionId: rev3,
    });

    expect(await reconcileApprovalsFor(documentId)).toHaveLength(1);
  });

  it("raises with added + removed clause lists and flags removed clause nodes", async () => {
    await seedCompany({ withCeo: true });
    const oldBody = "## PRD-story-1\nAlpha.\n## PRD-story-2\nBeta.";
    const { documentId, revisionId: fromRev } = await seedDocument(oldBody);
    const { clauseNodes } = await seedGrandPlan(documentId, ["PRD-story-1", "PRD-story-2"]);

    // Remove story-2, add story-3.
    const newBody = "## PRD-story-1\nAlpha.\n## PRD-story-3\nGamma.";
    const toRev = await addRevision(documentId, newBody, 2);

    await runPrdChangeCascade(db, {}, {
      documentId,
      companyId,
      oldBody,
      newBody,
      fromRevisionId: fromRev,
      toRevisionId: toRev,
    });

    const raised = await reconcileApprovalsFor(documentId);
    expect(raised).toHaveLength(1);
    const payload = raised[0].payload as Record<string, unknown>;
    expect(payload.added).toEqual(["PRD-story-3"]);
    expect(payload.removed).toEqual(["PRD-story-2"]);

    // Removed clause node flagged (parent_changed) — but never deleted.
    const clause2 = await gp.getById(clauseNodes["PRD-story-2"]);
    expect(clause2?.reconcileState).toBe("parent_changed");
    expect(clause2).not.toBeNull();
  });

  it("never throws even if the cascade internals error", async () => {
    await seedCompany({ withCeo: true });
    const oldBody = "## PRD-story-1\nAlpha.";
    const { documentId, revisionId: fromRev } = await seedDocument(oldBody);
    await seedGrandPlan(documentId, ["PRD-story-1"]);
    const newBody = "## PRD-story-1\nAlpha CHANGED.";
    const toRev = await addRevision(documentId, newBody, 2);

    // approvalService dep whose create throws -> cascade must swallow.
    const brokenApprovals = {
      ...approvalService(db),
      create: async () => {
        throw new Error("boom");
      },
    } as ReturnType<typeof approvalService>;

    await expect(
      runPrdChangeCascade(
        db,
        { approvalService: brokenApprovals },
        {
          documentId,
          companyId,
          oldBody,
          newBody,
          fromRevisionId: fromRev,
          toRevisionId: toRev,
        },
      ),
    ).resolves.toBeUndefined();
  });
});
