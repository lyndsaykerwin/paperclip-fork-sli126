# Grand Plan — Final Build Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Grand Plan a real, server-backed structure in Paperclip — a tree of PRD → Spec → Plan nodes that every issue traces to — replacing the brittle "clause IDs in description text" + browser-localStorage conventions with real database links, an enforced creation gate, a human-approved cascade when the PRD changes, and a live progress rollup.

**Architecture:** A new self-referencing `grand_plan_nodes` table (mirrors the existing `goals` tree pattern) holds the PRD/Spec/Plan tree; each node points at an existing `documents` row + a specific `document_revisions` row (no new document store). A new nullable `grandPlanNodeId` column on `issues` tethers each issue to its node. Behavior is layered onto Paperclip's existing single chokepoints: the gate at `issueService.create`, the rollup at `applyStatusSideEffects`, the cascade-approval via the existing `approvals` system (free-text `type = "grand_plan_reconcile"`), and the Steward gate via native `issue_blockers_resolved` auto-unblock. The UI "active plan" resolves to the real `tier='prd'` root node via the server instead of a localStorage pin.

**Tech Stack:** TypeScript monorepo, pnpm 9.15, Drizzle ORM (PostgreSQL; local embedded Postgres for migrations), Hono server, React UI, Vitest.

**Phasing (per Lyndsay's decision 2026-05-30):** Build in two phases. **Phase 1 = foundation/plumbing** (this plan, fully detailed). **Phase 2 = behaviors** (designed here with exact hook points; expanded into bite-sized steps once Phase 1 lands and SLI-123 is merged).

**Workspace:** Isolated worktree `~/Documents/Claude_Work/paperclip/.claude/worktrees/grand-plan-final-build` on branch `feat/grand-plan-final-build`, based on `master` @ `9eac727c`. The unfinished SLI-123 work is intentionally NOT in this workspace.

---

## Research grounding (verified in the real code, 2026-05-30)

| Concern | Finding | Path |
|---|---|---|
| Tree pattern to copy | `goals` self-references via `parentId: uuid(...).references((): AnyPgColumn => goals.id)`; every table has non-null `companyId`, indexed | `packages/db/src/schema/goals.ts` |
| Doc reuse | `documents.latestRevisionId/latestRevisionNumber`; `document_revisions` unique on `(documentId, revisionNumber)`, has `body/format/title/changeSummary` | `packages/db/src/schema/documents.ts`, `document_revisions.ts` |
| Nullable FK style | omit `.notNull()`, add `{ onDelete: "set null" }` | `packages/db/src/schema/issues.ts` |
| Approval type | `type: text("type").notNull()` — free text, no enum; `"grand_plan_reconcile"` needs zero schema change | `packages/db/src/schema/approvals.ts` |
| Schema registration | `export { x } from "./x.js"` alphabetical | `packages/db/src/schema/index.ts` |
| Migration workflow | `db:generate` = `check:migrations && tsc -p tsconfig.json && drizzle-kit generate`; `db:migrate` = `tsx src/migrate.ts`. drizzle-kit reads the **compiled `dist/schema/*.js`**, so you MUST use `pnpm db:generate` (it runs `tsc` first) — never run `drizzle-kit generate` directly or the new table won't appear. Output dir `packages/db/src/migrations/`; **next number is sequential — run `ls packages/db/src/migrations/ \| tail` to confirm the latest before generating (latest at time of writing: `0091_*`, so next is `0092_*`).** | `packages/db/drizzle.config.ts`, `packages/db/src/migrate.ts` |
| Issue-creation chokepoint (gate) | ONE function `issueService.create(companyId, data)` wraps `db.transaction`; route `/companies/:companyId/issues` calls only it | `server/src/services/issues.ts:~4061` (on master) |
| Status side-effects chokepoint (rollup) | `applyStatusSideEffects(status, patch)` is synchronous (timestamps only), called in `update()` | `server/src/services/issues.ts:101` (defn), called `~4384` (on master) |
| Blocker wake (Steward gate) | marking a blocker issue `done` fires `issue_blockers_resolved` and auto-unblocks dependents whose blockers are all done | `server/src/routes/issues.ts:~4660`, `listWakeableBlockedDependents` |

> **Line-number caveat:** the chokepoint research originally ran against the dirty SLI-123 branch (where `issues.ts` is +94 lines); the lines above are corrected to `master`. Function NAMES are stable and authoritative — **re-grep for the function name before editing in Phase 2**, since Phase 1 commits will shift line numbers again.
| Approval lifecycle | `approvalService(db).create/approve/reject/requestRevision/resubmit`; `approve()` fires `heartbeat.wakeup(reason:"approval_approved")`; add type-specific side-effect in `approve()` | `server/src/services/approvals.ts` |
| Doc-revision wake | does NOT exist today; Phase 2 must add a wake on PRD revision bump | (gap) |
| localStorage hack (kill) | key `"paperclip:grandPlanIssueId"`, auto-pins issue whose doc `key === "prd"`; lives ONLY in uncommitted SLI-123, NOT on master | `ui/src/components/SidebarActivePlan.tsx:18` |
| Test runner | Vitest. Root `pnpm test`. Per-package typecheck `pnpm --filter @paperclipai/db typecheck`. Service tests are `*.test.ts` next to the file. | root/`package.json` |

---

## File Structure

**Phase 1 — create:**
- `packages/db/src/schema/grand_plan_nodes.ts` — the new tree table (one responsibility: the schema).
- `packages/db/src/schema/grand_plan_nodes.test.ts` — schema-shape / tree insert+walk test.
- `packages/db/src/migrations/00XX_*.sql` — **generated** by drizzle-kit (never hand-written).
- `server/src/services/grand-plan.ts` — the grand-plan service: create node, get, read tree, find root, walk ancestors/descendants, attach document revision.
- `server/src/services/grand-plan.test.ts` — service unit tests.
- `server/src/routes/grand-plan.ts` — read endpoints (tree + root).
- `packages/shared/src/types/grand-plan.ts` — shared `GrandPlanNode` / tier / reconcileState types.

**Phase 1 — modify:**
- `packages/db/src/schema/issues.ts` — add nullable `grandPlanNodeId` column.
- `packages/db/src/schema/index.ts` — export `grandPlanNodes`.
- `packages/shared/src/types/index.ts` + `packages/shared/src/index.ts` — export the new types.
- `server/src/index.ts` (or the route registrar) — mount `grand-plan` routes.

**Phase 2 — modify (designed below, not yet stepped):**
- `server/src/services/issues.ts` — the gate (in `create`) + the rollup (after `applyStatusSideEffects`).
- `server/src/services/approvals.ts` — `grand_plan_reconcile` side-effect in `approve()`.
- `server/src/services/document-revisions` (or revision-creation site) — wake the Steward on PRD revision bump (top-down cascade trigger).
- `ui/src/components/SidebarActivePlan.tsx` + `ui/src/api/` — replace localStorage pin with a server call for the `tier='prd'` root (reconcile with SLI-123).

---

## Design decisions (locked for Phase 1)

- **`tier`** is a free-text column constrained at the app layer to `'prd' | 'spec' | 'plan'`. (Matches `goals.level`/`approvals.type` free-text convention — no pg enum.)
- **`reconcileState`** free-text, default `'current'`; Phase-2 cascade sets `'parent_changed'` (the "stale" flag).
- **`rollupPercent`** integer 0–100, default 0; Phase-2 rollup writes it. Phase 1 only stores/serves it.
- **`ownerAgentId`** nullable FK to `agents` — this is where the "4 owners" (section 8) live, one per node.
- **`documentId` + `sourceRevisionId`** — node points at an existing document and the specific revision it was built from (section 2: reuse, don't re-store).
- **One root per (company, project):** the `tier='prd'` node with `parentId = null`. Enforced at the service layer in Phase 1 (not a DB constraint yet) — `getRoot` returns it; `create` rejects a second `prd` root for the same scope.
- **Tree integrity:** `parentId` self-FK with default (no cascade delete) — mirrors `goals`. Deleting a node with children is blocked at the service layer.

---

## Phase 1 — Foundation

### Task 1: Create the `grand_plan_nodes` schema

**Files:**
- Create: `packages/db/src/schema/grand_plan_nodes.ts`
- Test: `packages/db/src/schema/grand_plan_nodes.test.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Read the pattern.** Open `packages/db/src/schema/goals.ts` and note its EXACT conventions (import list, timestamp column style, index helper, `AnyPgColumn` self-ref). The new file must match these line-for-line in style. Also open `documents.ts` and `document_revisions.ts` for the FK targets.

- [ ] **Step 2: Write the failing test** at `packages/db/src/schema/grand_plan_nodes.test.ts`. Follow the DB-test harness used by an existing schema/service test (e.g. `server/src/services/issue-thread-interactions.test.ts` for how a test DB/transaction is obtained). Test asserts: (a) a `prd` root node inserts with `reconcileState='current'`, `rollupPercent=0` defaults; (b) a `spec` child with `parentId` = root inserts; (c) selecting by `parentId` returns the child (tree walk works).

```ts
// grand_plan_nodes.test.ts — shape (adapt harness to repo convention)
import { describe, it, expect } from "vitest";
import { grandPlanNodes } from "./grand_plan_nodes.js";
// ...obtain a test db `tx` per existing harness...
it("inserts a prd root then a spec child and walks parent→child", async () => {
  const [root] = await tx.insert(grandPlanNodes).values({
    companyId, tier: "prd", title: "SlideForge PRD",
  }).returning();
  expect(root.reconcileState).toBe("current");
  expect(root.rollupPercent).toBe(0);
  const [spec] = await tx.insert(grandPlanNodes).values({
    companyId, tier: "spec", title: "Engineering Spec", parentId: root.id,
  }).returning();
  const kids = await tx.select().from(grandPlanNodes).where(eq(grandPlanNodes.parentId, root.id));
  expect(kids.map(k => k.id)).toContain(spec.id);
});
```

- [ ] **Step 3: Run the test, verify it fails** with "Cannot find module './grand_plan_nodes.js'" (or table-undefined).
Run: `pnpm --filter @paperclipai/db test grand_plan_nodes`

- [ ] **Step 4: Write the schema** at `packages/db/src/schema/grand_plan_nodes.ts`, mirroring `goals.ts` style:

```ts
import { pgTable, uuid, text, integer, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { documents } from "./documents.js";
import { documentRevisions } from "./document_revisions.js";

export const grandPlanNodes = pgTable("grand_plan_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  projectId: uuid("project_id").references(() => projects.id),
  parentId: uuid("parent_id").references((): AnyPgColumn => grandPlanNodes.id),
  tier: text("tier").notNull(),                              // 'prd' | 'spec' | 'plan'
  title: text("title").notNull(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  sourceRevisionId: uuid("source_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
  reconcileState: text("reconcile_state").notNull().default("current"), // 'current' | 'parent_changed'
  rollupPercent: integer("rollup_percent").notNull().default(0),
  ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyIdx: index("grand_plan_nodes_company_id_idx").on(table.companyId),
  parentIdx: index("grand_plan_nodes_parent_id_idx").on(table.parentId),
  projectIdx: index("grand_plan_nodes_project_id_idx").on(table.projectId),
}));
```
> If `goals.ts` uses a shared `timestamps` helper or a different index signature, match THAT instead of the literal above.

- [ ] **Step 5: Register the export** in `packages/db/src/schema/index.ts` — add `export { grandPlanNodes } from "./grand_plan_nodes.js";` in alphabetical position (after `goals`).

- [ ] **Step 6: Run the test, verify it passes.** Run: `pnpm --filter @paperclipai/db test grand_plan_nodes`

- [ ] **Step 7: Typecheck the db package.** Run: `pnpm --filter @paperclipai/db typecheck` — expect clean.

- [ ] **Step 8: Commit.**
```bash
git add packages/db/src/schema/grand_plan_nodes.ts packages/db/src/schema/grand_plan_nodes.test.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add grand_plan_nodes tree schema"
```

### Task 2: Add `grandPlanNodeId` to issues

**Files:**
- Modify: `packages/db/src/schema/issues.ts`

- [ ] **Step 1: Read** `packages/db/src/schema/issues.ts` nullable-FK columns (e.g. `goalId`) to match style and find the right insertion spot (near other plan/goal FKs).

- [ ] **Step 2: Add the import + column.** At top, import `grandPlanNodes`. In the table body, add:
```ts
grandPlanNodeId: uuid("grand_plan_node_id").references((): AnyPgColumn => grandPlanNodes.id, { onDelete: "set null" }),
```
(Import `AnyPgColumn` if not already imported.)

- [ ] **Step 3: Typecheck.** Run: `pnpm --filter @paperclipai/db typecheck` — expect clean. (No new test here; column is exercised by the Phase-2 gate tests. This keeps the step honest — we don't fake a test for a bare column.)

- [ ] **Step 4: Commit.**
```bash
git add packages/db/src/schema/issues.ts
git commit -m "feat(db): tether issues to grand plan via grandPlanNodeId column"
```

### Task 3: Generate and apply the migration

**Files:**
- Create (generated): `packages/db/src/migrations/00XX_*.sql` + journal entry

- [ ] **Step 0: Confirm the next number.** Run: `ls packages/db/src/migrations/ | tail -3` and note the highest existing number N. The generated file will be `00(N+1)_*` (at time of writing latest is `0091`, so expect `0092_*`). Do NOT hardcode an expectation — read the actual latest.

- [ ] **Step 1: Generate.** Run: `pnpm db:generate` (NEVER run `drizzle-kit generate` directly — it reads compiled `dist/` and would miss the new table; `db:generate` runs `tsc` first).
Expected: compiles, then drizzle-kit writes a new `packages/db/src/migrations/00(N+1)_*.sql` containing `CREATE TABLE "grand_plan_nodes" (...)` + `ALTER TABLE "issues" ADD COLUMN "grand_plan_node_id"`. The `check:migrations` numbering check must pass.

- [ ] **Step 2: Review the generated SQL by eye.** Open the new `00XX_*.sql`. Confirm: table created with all columns + FKs + 3 indexes; the issues ALTER adds exactly one nullable column with `ON DELETE SET NULL`; no unexpected drops/renames of other tables. If anything unexpected appears, STOP and report (do not edit SQL by hand — fix the schema and regenerate).

- [ ] **Step 3: Apply to local embedded Postgres.** Before running, confirm BOTH safety conditions: (a) `echo $DATABASE_URL` is empty, AND (b) there is no repo-local `.paperclip/.env` (or `.paperclip/config.json`) pointing at a real DB — `cat .paperclip/.env 2>/dev/null`. Only the embedded local Postgres is safe. Then run: `pnpm db:migrate`
Expected: migration applies cleanly; exits 0. (If either a `DATABASE_URL` or a `.paperclip/.env` connection string points at a real/remote DB, STOP and confirm with the human first — see Hard constraints.)

- [ ] **Step 4: Re-run the db test against the migrated DB.** Run: `pnpm --filter @paperclipai/db test grand_plan_nodes` — expect pass.

- [ ] **Step 5: Commit the generated migration.**
```bash
git add packages/db/src/migrations/
git commit -m "feat(db): migration for grand_plan_nodes + issues.grand_plan_node_id"
```

### Task 4: Shared types

**Files:**
- Create: `packages/shared/src/types/grand-plan.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/index.ts`

- [ ] **Step 1: Read** how an existing domain type (e.g. an Issue or Goal type) is declared/exported in `packages/shared/src/types/` to match style.

- [ ] **Step 2: Write the types** in `grand-plan.ts`:
```ts
export type GrandPlanTier = "prd" | "spec" | "plan";
export type GrandPlanReconcileState = "current" | "parent_changed";

export interface GrandPlanNode {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  tier: GrandPlanTier;
  title: string;
  documentId: string | null;
  sourceRevisionId: string | null;
  reconcileState: GrandPlanReconcileState;
  rollupPercent: number;
  ownerAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GrandPlanTreeNode extends GrandPlanNode {
  children: GrandPlanTreeNode[];
}
```

- [ ] **Step 3: Export** from `types/index.ts` and `src/index.ts` (match existing re-export style).

- [ ] **Step 4: Typecheck shared.** Run: `pnpm --filter @paperclipai/shared typecheck` — expect clean.

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/types/grand-plan.ts packages/shared/src/types/index.ts packages/shared/src/index.ts
git commit -m "feat(shared): GrandPlanNode types"
```

### Task 5: Grand-plan service

**Files:**
- Create: `server/src/services/grand-plan.ts`
- Test: `server/src/services/grand-plan.test.ts`

- [ ] **Step 1: Read** an existing service factory (`server/src/services/approvals.ts` shows the `service(db)` factory + transaction pattern) to match conventions.

- [ ] **Step 2: Write failing tests** in `grand-plan.test.ts` covering: (a) `create` a `prd` root; (b) `create` rejects a SECOND `prd` root for the same company/project; (c) `getRoot(companyId, projectId)` returns the prd root; (d) `getAncestors(childId)` returns `[spec, prd]` for a plan→spec→prd chain; (e) `getTree(companyId, projectId)` returns nested `children`; (f) `attachDocument(nodeId, documentId, revisionId)` sets both columns.

- [ ] **Step 3: Run tests, verify they fail.** Run: `pnpm test grand-plan`

- [ ] **Step 4: Implement the service.** Functions: `create`, `getById`, `getRoot`, `getAncestors` (walk `parentId` to root), `getDescendants`, `getTree` (assemble nested), `attachDocument`, `setReconcileState` (used in Phase 2), `setRollupPercent` (used in Phase 2). All writes inside `db.transaction`. Root-uniqueness enforced in `create`.

- [ ] **Step 5: Run tests, verify pass.** Run: `pnpm test grand-plan`

- [ ] **Step 6: Typecheck server.** Run: `pnpm --filter @paperclipai/server typecheck`

- [ ] **Step 7: Commit.**
```bash
git add server/src/services/grand-plan.ts server/src/services/grand-plan.test.ts
git commit -m "feat(server): grand-plan service (tree read/write, root, ancestors)"
```

### Task 6: Read routes (tree + root)

**Files:**
- Create: `server/src/routes/grand-plan.ts`
- Modify: route registrar (`server/src/index.ts` or wherever route modules mount)

- [ ] **Step 1: Read** an existing read-only route module + how routes are registered, and the auth/`assertBoard`/company-scope middleware pattern.

- [ ] **Step 2: Write failing route test** (follow existing route-test harness): `GET /companies/:companyId/grand-plan` returns the nested tree; `GET /companies/:companyId/grand-plan/root` returns the prd root (404 if none).

- [ ] **Step 3: Run, verify fail.**

- [ ] **Step 4: Implement routes** delegating to the service; apply the same company-scope auth as neighboring routes. Mount in the registrar.

- [ ] **Step 5: Run, verify pass.**

- [ ] **Step 6: Typecheck + full build.** Run: `pnpm --filter @paperclipai/server typecheck` then `pnpm build`.

- [ ] **Step 7: Commit.**
```bash
git add server/src/routes/grand-plan.ts server/src/index.ts
git commit -m "feat(server): read endpoints for grand plan tree and root"
```

### Task 7: Phase 1 verification gate

- [ ] **Step 1:** Run the full relevant test set: `pnpm test` (or scoped: db + server + shared).
- [ ] **Step 2:** Run `pnpm typecheck` across the workspace — expect clean.
- [ ] **Step 3:** Start the server (`pnpm --filter @paperclipai/server dev`) against the local embedded DB, hit `GET /companies/:id/grand-plan/root` with a seeded prd node, confirm JSON shape matches `GrandPlanNode`. Report the actual response.
- [ ] **Step 4:** Write a short Phase-1 completion note to `docs/plans/2026-05-30-grand-plan-final-build.progress.md` (what shipped, the migration number, any deviations) and STOP for human review before Phase 2.

---

## Phase 2 — Behaviors (design + exact hook points; to be expanded into bite-sized steps after Phase 1 + SLI-123 merge)

> Each item below names the verified hook point. When Phase 1 is merged, expand each into the same Write-test → fail → implement → pass → commit rhythm.

> **Before expanding any B-item:** re-grep the function name on the current branch (line numbers below are master-relative and will drift after Phase 1 commits).

### B1 — The Steward gate (section 5): "no issue outside the plan"
- **Hook:** `issueService.create` (`server/src/services/issues.ts`, ~`:4061` on master), inside its `db.transaction`.
- **Behavior:** accept an optional `grandPlanNodeId` on `IssueCreateInput`.
  - If present and valid → set it on the issue (tethered).
  - If absent → create/attach to an **"unanchored"** node (a reserved node, e.g. `tier='plan'`, `title="Unanchored"`, `reconcileState='parent_changed'` as the drift flag) AND, per the Steward mechanism, self-set `blockedByIssueIds: [tether-check issue assigned to PM/Steward]`. The Steward rules later (clean → mark tether-check `done` → native `issue_blockers_resolved` auto-unblocks; drift → raise approval to Lyndsay; new direction → update plan w/ her sign-off).
- **Why native blockers:** cross-agent mutation of status/blockers 403s even for CEO; the Steward only touches its own tether-check issue (verified `routes/issues.ts:3690` auto-unblock).
- **Tests:** create-with-valid-node tethers; create-without-node lands unanchored + blocked; marking tether-check done unblocks.

### B2 — Cascade when the PRD changes (section 6): YOU APPROVE
- **Hooks:** (a) the place a new `document_revisions` row is created for a PRD-tier document — add a **wake to the Steward** (this wake does NOT exist today; build it). (b) `approvalService.approve()` (`server/src/services/approvals.ts`, ~`:102`) — add a `type === "grand_plan_reconcile"` side-effect branch.
- **Behavior:** PRD doc gets a new revision → walk descendants of the PRD node → set `reconcileState='parent_changed'` ("stale") on nodes built from the old revision → owner agent drafts a fix → create an `approvals` row `type:"grand_plan_reconcile"` linked to the affected issue(s) via `issueApprovalService.linkManyForApproval`. **Lyndsay approves** → `approve()` side-effect applies the draft and resets `reconcileState='current'` + bumps `sourceRevisionId`. Reject/requestRevision → agent redraws with her note. No table change (free-text type confirmed).
- **Tests:** revision bump flags descendants stale; approval apply clears stale + advances `sourceRevisionId`; reject leaves stale + records note.

### B3 — Live progress rollup (section 7)
- **Hook:** in `issueService.update`, immediately after the `applyStatusSideEffects(...)` call (`server/src/services/issues.ts`, ~`:4384` on master), inside the same transaction.
- **Behavior:** when an issue transitions to `done` (and on un-done), if it has `grandPlanNodeId`, recompute that node's `rollupPercent` from its issues + child nodes, then climb `parentId` to the root recomputing each ancestor (plan → spec → prd). Same transaction, no clock.
- **Tests:** completing the only issue under a plan node ticks plan→spec→prd to 100; partial completion computes weighted percent; reverting recomputes down.

### B4 — Kill the localStorage pin (section 9) — reconcile with SLI-123
- **Hooks:** `ui/src/components/SidebarActivePlan.tsx` (key `"paperclip:grandPlanIssueId"`), `ui/src/api/`.
- **Behavior:** replace the browser-pin with a call to `GET /companies/:id/grand-plan/root` (built in Task 6) → the "Active plan" nav links to the real `tier='prd'` node from any device. Remove the localStorage read/write.
- **Dependency:** the localStorage code exists only in unfinished SLI-123. Do this step ONLY after SLI-123 is merged to master (or in coordination), rebasing this branch first, to avoid a tangle. Confirm with Lyndsay which lands first.
- **Tests:** sidebar resolves active plan from server with no localStorage; behaves with zero/one prd root.

### Section 8 (keep what's built)
- No rebuild. `ownerAgentId` (Task 1) stores the 4 owners per node; the 5 docs become node `documentId`s; the Steward gate reuses native blockers (B1). This is honored by the design above, not a separate task.

---

## Hard constraints / gotchas

- **Never hand-edit migration SQL.** Edit schema → `pnpm db:generate`. If the generated SQL looks wrong, fix the schema and regenerate.
- **Migrations: confirm BOTH `DATABASE_URL` is unset AND no `.paperclip/.env`/`config.json` connection string** before `pnpm db:migrate`, so it hits the safe local embedded Postgres. The migration runtime reads `DATABASE_URL` first, then a repo-local `.paperclip/.env`. If either points at a real/remote DB, STOP and confirm with Lyndsay.
- **Never cross-mutate another agent's status/blockers** (403 even as CEO) — use the native tether-check blocker mechanism in B1.
- **Don't touch the other 7 worktrees** under `.claude/worktrees/` or the SLI-123 branch.
- **SLI-123 entanglement:** B4 must be sequenced against SLI-123's merge; everything else is independent of it.
- **Frozen prose, volatile status:** node `title`/document body are written once; only `rollupPercent` and `reconcileState` churn.
```
