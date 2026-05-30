import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { grandPlanService } from "../services/grand-plan.js";
import { assertCompanyAccess } from "./authz.js";

export function grandPlanRoutes(db: Db) {
  const router = Router();
  const svc = grandPlanService(db);

  router.get("/companies/:companyId/grand-plan", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await svc.getTree(companyId, null);
    res.json(tree);
  });

  router.get("/companies/:companyId/grand-plan/root", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await svc.getRoot(companyId, null);
    if (!root) {
      res.status(404).json({ error: "Grand plan root not found" });
      return;
    }
    res.json(root);
  });

  return router;
}
