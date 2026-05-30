import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGrandPlanService = vi.hoisted(() => ({
  getTree: vi.fn(),
  getRoot: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getDescendants: vi.fn(),
  attachDocument: vi.fn(),
  setReconcileState: vi.fn(),
  setRollupPercent: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/grand-plan.js", () => ({
    grandPlanService: () => mockGrandPlanService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ grandPlanRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/grand-plan.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", grandPlanRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const TREE_NODE = {
  id: "node-1",
  companyId: "company-1",
  projectId: null,
  parentId: null,
  tier: "prd",
  title: "My PRD",
  documentId: null,
  sourceRevisionId: null,
  reconcileState: "pending",
  rollupPercent: 0,
  ownerAgentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  children: [],
};

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

describe("grand plan routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/grand-plan.js");
    vi.doUnmock("../routes/grand-plan.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  describe("GET /api/companies/:companyId/grand-plan", () => {
    it("returns the tree for a company that has one", async () => {
      mockGrandPlanService.getTree.mockResolvedValue(TREE_NODE);

      const app = await createApp(BOARD_ACTOR);
      const res = await request(app).get("/api/companies/company-1/grand-plan");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(TREE_NODE);
      expect(mockGrandPlanService.getTree).toHaveBeenCalledWith("company-1", null);
    });

    it("returns null body with 200 when no tree exists", async () => {
      mockGrandPlanService.getTree.mockResolvedValue(null);

      const app = await createApp(BOARD_ACTOR);
      const res = await request(app).get("/api/companies/company-1/grand-plan");

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("returns 403 when the board user lacks company access", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-2",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-2"],
      });

      const res = await request(app).get("/api/companies/company-1/grand-plan");

      expect(res.status).toBe(403);
      expect(mockGrandPlanService.getTree).not.toHaveBeenCalled();
    });

    it("returns 401 for unauthenticated callers", async () => {
      const app = await createApp({ type: "none", source: "none" });
      const res = await request(app).get("/api/companies/company-1/grand-plan");

      expect(res.status).toBe(401);
      expect(mockGrandPlanService.getTree).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/companies/:companyId/grand-plan/root", () => {
    it("returns the prd root node when one exists", async () => {
      const rootNode = { ...TREE_NODE };
      delete (rootNode as Record<string, unknown>).children;
      mockGrandPlanService.getRoot.mockResolvedValue(rootNode);

      const app = await createApp(BOARD_ACTOR);
      const res = await request(app).get("/api/companies/company-1/grand-plan/root");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(rootNode);
      expect(mockGrandPlanService.getRoot).toHaveBeenCalledWith("company-1", null);
    });

    it("returns 404 when no root exists", async () => {
      mockGrandPlanService.getRoot.mockResolvedValue(null);

      const app = await createApp(BOARD_ACTOR);
      const res = await request(app).get("/api/companies/company-1/grand-plan/root");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Grand plan root not found" });
    });

    it("returns 403 when the board user lacks company access", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-2",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-2"],
      });

      const res = await request(app).get("/api/companies/company-1/grand-plan/root");

      expect(res.status).toBe(403);
      expect(mockGrandPlanService.getRoot).not.toHaveBeenCalled();
    });

    it("returns 401 for unauthenticated callers", async () => {
      const app = await createApp({ type: "none", source: "none" });
      const res = await request(app).get("/api/companies/company-1/grand-plan/root");

      expect(res.status).toBe(401);
      expect(mockGrandPlanService.getRoot).not.toHaveBeenCalled();
    });
  });
});
