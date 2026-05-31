import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, companies } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { findCompanyCeoAgentId } from "./company-ceo.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("findCompanyCeoAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-ceo-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  it("returns the agent explicitly roled 'ceo' when one exists", async () => {
    await seedCompany();
    const ceoId = randomUUID();
    await db.insert(agents).values({ id: ceoId, companyId, name: "Boss", role: "ceo" });
    // an unrelated org-root agent that should NOT win over the explicit ceo role
    await db.insert(agents).values({ id: randomUUID(), companyId, name: "Other", role: "agent", reportsTo: null });
    expect(await findCompanyCeoAgentId(db, companyId)).toBe(ceoId);
  });

  it("falls back to the org-root (reportsTo null) when no role='ceo' exists", async () => {
    await seedCompany();
    const rootId = randomUUID();
    // CEO created with role 'agent' (the SlideForge case) — only org structure marks it.
    await db.insert(agents).values({
      id: rootId,
      companyId,
      name: "CEO",
      role: "agent",
      title: "Chief Executive Officer",
      reportsTo: null,
    });
    // a managed agent reporting to the root must not be chosen
    await db.insert(agents).values({ id: randomUUID(), companyId, name: "IC", role: "agent", reportsTo: rootId });
    expect(await findCompanyCeoAgentId(db, companyId)).toBe(rootId);
  });

  it("prefers a CEO-looking root when several roots exist", async () => {
    await seedCompany();
    await db.insert(agents).values({ id: randomUUID(), companyId, name: "Floating Researcher", role: "agent", reportsTo: null });
    const ceoId = randomUUID();
    await db.insert(agents).values({ id: ceoId, companyId, name: "CEO", role: "agent", title: "Chief Executive Officer", reportsTo: null });
    expect(await findCompanyCeoAgentId(db, companyId)).toBe(ceoId);
  });

  it("returns null for a company with no agents", async () => {
    await seedCompany();
    expect(await findCompanyCeoAgentId(db, companyId)).toBeNull();
  });
});
