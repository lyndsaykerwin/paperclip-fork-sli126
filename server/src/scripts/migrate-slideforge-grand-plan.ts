/**
 * B5 — Migrate the existing SlideForge plan into the Grand Plan node structure.
 *
 * Reads the LIVE SlideForge planning docs (PRD + Tether Map) off SLI-1 and the
 * SLI issues, then builds the node tree:
 *
 *   PRD doc-root (tier=prd, parentId=null)
 *     └─ one clause node per PRD clause ID (tier=prd)
 *          └─ one Spec node (tier=spec)        [only for clauses with issues]
 *               └─ one Plan node (tier=plan)
 *                    └─ tethered SLI issues (issues.grandPlanNodeId)
 *
 * Mapping is taken STRICTLY from the Tether Map. No mappings are invented:
 * every issue→clause link comes from a Tether Map row's PRIMARY clause (the
 * bolded one, else the first listed). Issues the map marks off-ledger (the
 * "Internal tooling" section) and issues the map never names are left
 * UNTETHERED and listed, never guessed.
 *
 * Default mode is DRY-RUN (reports what it WOULD do, writes nothing).
 * Pass --apply to actually write. Idempotent: re-running yields no duplicates
 * (nodes match on companyId + tier + title + parentId; tethering is a set).
 *
 * Run from the paperclip repo root, e.g.:
 *   node --import tsx server/src/scripts/migrate-slideforge-grand-plan.ts          # dry-run
 *   node --import tsx server/src/scripts/migrate-slideforge-grand-plan.ts --apply  # apply
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  createDb,
  documents,
  grandPlanNodes,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { grandPlanService } from "../services/grand-plan.js";
import { recomputeGrandPlanRollupForNodeAndAncestors } from "../services/grand-plan-rollup.js";

const SLIDEFORGE_COMPANY_ID = "ecb8fe84-ef3e-4e93-be74-6b86f10ed7f8";
const PLAN_ISSUE_IDENTIFIER = "SLI-1";
const DOC_ROOT_TITLE = "SlideForge PRD";
const DEFAULT_DB_URL = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const APPLY = process.argv.includes("--apply");

function resolveDbUrl(): string {
  const url = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const looksRemote = /supabase\.|amazonaws|neon\.tech|render\.com|\.cloud/i.test(url);
  const looksLocal = /127\.0\.0\.1|localhost/i.test(url);
  if (looksRemote || !looksLocal) {
    if (process.env.ALLOW_REMOTE !== "1") {
      throw new Error(
        `Refusing to run against a non-local DB URL (${url}). ` +
          `This migration writes to the live board. Set ALLOW_REMOTE=1 to override.`,
      );
    }
  }
  return url;
}

// --- markdown / clause parsing helpers -------------------------------------

function parseClauseIdsInOrder(body: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const re = /PRD-[a-z0-9]+(?:-[a-z0-9]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) != null) {
    const id = m[0].replace(/-+$/, "");
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * Split a cell's SLI references into explicit single mentions vs numbers that
 * only appear because they fall inside a range like "SLI-68–SLI-99". Explicit
 * mentions are authoritative; range-derived numbers are shorthand and yield to
 * any explicit mention elsewhere (the Tether Map names off-ledger/sell-it
 * issues explicitly but also sweeps some of them inside a product range).
 */
function extractIssueNumbers(cell: string): { explicit: number[]; range: number[] } {
  const range = new Set<number>();
  const rangeEndpoints = new Set<number>();
  const rangeRe = /SLI-(\d+)\s*[–—-]\s*SLI-(\d+)/g;
  let r: RegExpExecArray | null;
  while ((r = rangeRe.exec(cell)) != null) {
    const a = Number(r[1]);
    const b = Number(r[2]);
    rangeEndpoints.add(a);
    rangeEndpoints.add(b);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let n = lo; n <= hi; n++) range.add(n);
  }
  // Explicit = every standalone SLI-N that is NOT merely a range endpoint.
  const explicit = new Set<number>();
  const singleRe = /SLI-(\d+)/g;
  let s: RegExpExecArray | null;
  while ((s = singleRe.exec(cell)) != null) {
    const n = Number(s[1]);
    if (!rangeEndpoints.has(n)) explicit.add(n);
  }
  // A number that is both an explicit mention and inside a range stays explicit.
  for (const n of explicit) range.delete(n);
  return { explicit: [...explicit], range: [...range] };
}

function primaryClause(cell: string): string | null {
  const bold = /\*\*[^*]*?(PRD-[a-z0-9]+(?:-[a-z0-9]+)*)/.exec(cell);
  if (bold) return bold[1].replace(/-+$/, "");
  const first = /PRD-[a-z0-9]+(?:-[a-z0-9]+)*/.exec(cell);
  return first ? first[0].replace(/-+$/, "") : null;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c));
}

interface ProductRow {
  checkpoint: string;
  clause: string | null;
  explicitNums: number[];
  rangeNums: number[];
  section: string;
}

interface ParsedTetherMap {
  productRows: ProductRow[];
  offLedgerExplicit: Set<number>;
  offLedgerRange: Set<number>;
}

function parseTetherMap(body: string): ParsedTetherMap {
  const productRows: ProductRow[] = [];
  const offLedgerExplicit = new Set<number>();
  const offLedgerRange = new Set<number>();
  let section = "";
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    if (isSeparatorRow(cells)) continue;
    // header rows have "Issues" as the second column label
    if (/^issues$/i.test(cells[1])) continue;

    const isInternal = /internal tooling/i.test(section);
    const isPromised = /promised/i.test(section);
    if (isPromised) continue;

    const { explicit, range } = extractIssueNumbers(cells[1]);
    if (explicit.length === 0 && range.length === 0) continue;

    if (isInternal) {
      for (const n of explicit) offLedgerExplicit.add(n);
      for (const n of range) offLedgerRange.add(n);
      continue;
    }
    // product section: clause is column index 2
    const clauseCell = cells[2] ?? "";
    productRows.push({
      checkpoint: cells[0],
      clause: primaryClause(clauseCell),
      explicitNums: explicit,
      rangeNums: range,
      section,
    });
  }
  return { productRows, offLedgerExplicit, offLedgerRange };
}

// --- main ------------------------------------------------------------------

async function main() {
  const dbUrl = resolveDbUrl();
  const db = createDb(dbUrl);

  const log = (...a: unknown[]) => console.log(...a);
  log("=".repeat(72));
  log(`SlideForge Grand Plan migration — ${APPLY ? "APPLY (writes!)" : "DRY-RUN (no writes)"}`);
  log(`DB: ${dbUrl}`);
  log("=".repeat(72));

  // 1) Resolve SLI-1 + its docs via issue_documents -------------------------
  const planIssue = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, SLIDEFORGE_COMPANY_ID),
        eq(issues.identifier, PLAN_ISSUE_IDENTIFIER),
      ),
    )
    .then((r) => r[0] ?? null);
  if (!planIssue) throw new Error(`Could not find ${PLAN_ISSUE_IDENTIFIER}`);

  const docRows = await db
    .select({
      key: issueDocuments.key,
      documentId: documents.id,
      title: documents.title,
      body: documents.latestBody,
      latestRevisionId: documents.latestRevisionId,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(eq(issueDocuments.issueId, planIssue.id));

  const docByKey = new Map(docRows.map((d) => [d.key, d]));
  const prdDoc = docByKey.get("prd");
  const specDoc = docByKey.get("spec");
  const planDoc = docByKey.get("plan");
  const tetherDoc = docByKey.get("tether-map");
  if (!prdDoc) throw new Error("No 'prd' doc on SLI-1");
  if (!tetherDoc) throw new Error("No 'tether-map' doc on SLI-1");

  // sanity: confirm we read the docs we think we did
  if (!/SlideForge\s*[—-]\s*PRD/i.test(prdDoc.body)) {
    throw new Error("'prd' doc body does not look like the SlideForge PRD — aborting");
  }
  if (!/Tether Map/i.test(tetherDoc.body)) {
    throw new Error("'tether-map' doc body does not look like the Tether Map — aborting");
  }
  log(`Resolved docs on ${PLAN_ISSUE_IDENTIFIER}: ${[...docByKey.keys()].join(", ")}`);

  // 2) Parse PRD clauses + tether map ---------------------------------------
  const prdClauses = parseClauseIdsInOrder(prdDoc.body);
  const { productRows, offLedgerExplicit, offLedgerRange } = parseTetherMap(tetherDoc.body);

  // Resolve each issue number to exactly one destination with this precedence,
  // so a loose range never overrides an explicit single mention:
  //   1. off-ledger explicit  -> untethered (drift)
  //   2. product explicit     -> that clause's plan node
  //   3. off-ledger range     -> untethered (drift)
  //   4. product range        -> that clause's plan node
  const clauseByIssueNum = new Map<number, string>();
  const offLedgerNums = new Set<number>();
  const conflicts: Array<{ num: number; existing: string; alsoIn: string }> = [];
  const rowsMissingClause: ProductRow[] = [];
  const assigned = new Set<number>();

  // Pass 1: off-ledger explicit
  for (const n of offLedgerExplicit) {
    offLedgerNums.add(n);
    assigned.add(n);
  }
  // Pass 2: product explicit
  for (const row of productRows) {
    if (!row.clause) {
      if (row.explicitNums.length || row.rangeNums.length) rowsMissingClause.push(row);
      continue;
    }
    for (const n of row.explicitNums) {
      if (assigned.has(n)) {
        const prior = clauseByIssueNum.get(n);
        if (prior && prior !== row.clause) {
          conflicts.push({ num: n, existing: prior, alsoIn: row.clause });
        }
        continue;
      }
      clauseByIssueNum.set(n, row.clause);
      assigned.add(n);
    }
  }
  // Pass 3: off-ledger range
  for (const n of offLedgerRange) {
    if (assigned.has(n)) continue;
    offLedgerNums.add(n);
    assigned.add(n);
  }
  // Pass 4: product range
  for (const row of productRows) {
    if (!row.clause) continue;
    for (const n of row.rangeNums) {
      if (assigned.has(n)) {
        const prior = clauseByIssueNum.get(n);
        if (prior && prior !== row.clause) {
          conflicts.push({ num: n, existing: prior, alsoIn: row.clause });
        }
        continue;
      }
      clauseByIssueNum.set(n, row.clause);
      assigned.add(n);
    }
  }

  // Build per-clause issue sets from the resolved assignment.
  const issueNumsByClause = new Map<string, Set<number>>();
  for (const [n, clause] of clauseByIssueNum) {
    let set = issueNumsByClause.get(clause);
    if (!set) {
      set = new Set<number>();
      issueNumsByClause.set(clause, set);
    }
    set.add(n);
  }

  // Clause node set = PRD clauses ∪ clauses referenced by the tether map.
  const tetherClauses = [...issueNumsByClause.keys()];
  const clauseNotInPrd = tetherClauses.filter((c) => !prdClauses.includes(c));
  const allClauses = [...prdClauses, ...clauseNotInPrd];

  // 3) Load all SlideForge issues ------------------------------------------
  const allIssues = await db
    .select()
    .from(issues)
    .where(eq(issues.companyId, SLIDEFORGE_COMPANY_ID));
  const issueByNum = new Map<number, (typeof allIssues)[number]>();
  for (const i of allIssues) {
    if (i.issueNumber != null) issueByNum.set(i.issueNumber, i);
  }

  // Resolve which issue numbers actually exist.
  const tetheredNums = new Set<number>();
  const missingNums: number[] = [];
  for (const n of clauseByIssueNum.keys()) {
    if (issueByNum.has(n)) tetheredNums.add(n);
    else missingNums.push(n);
  }

  // Off-ledger that exist.
  const offLedgerExisting = [...offLedgerNums].filter((n) => issueByNum.has(n));

  // Genuinely unmapped = issues that exist but are neither tethered nor
  // off-ledger and are not SLI-1 itself.
  const unmapped: number[] = [];
  for (const i of allIssues) {
    const n = i.issueNumber;
    if (n == null) continue;
    if (i.identifier === PLAN_ISSUE_IDENTIFIER) continue;
    if (tetheredNums.has(n)) continue;
    if (offLedgerNums.has(n)) continue;
    unmapped.push(n);
  }

  // --- REPORT --------------------------------------------------------------
  const clausesWithIssues = allClauses.filter(
    (c) => (issueNumsByClause.get(c)?.size ?? 0) > 0,
  );
  const uncoveredClauses = allClauses.filter(
    (c) => (issueNumsByClause.get(c)?.size ?? 0) === 0,
  );

  log("");
  log(`PRD clause nodes to ensure: ${allClauses.length}`);
  log(`  with tethered issues (get Spec+Plan): ${clausesWithIssues.length}`);
  log(`  uncovered (no issues, render "uncovered"): ${uncoveredClauses.length}`);
  if (clauseNotInPrd.length) {
    log(`  ⚠ referenced by tether map but NOT in PRD: ${clauseNotInPrd.join(", ")}`);
  }
  log("");
  log("Per-clause tethering (primary-clause rule):");
  for (const c of clausesWithIssues) {
    const nums = [...(issueNumsByClause.get(c) ?? [])]
      .filter((n) => issueByNum.has(n))
      .sort((a, b) => a - b);
    const aheadOfGate = /ahead of the sell-it gate/i.test(
      productRows.find((r) => r.clause === c)?.section ?? "",
    );
    const flag = c.startsWith("PRD-later-") ? "  [⚠ later/ahead-of-gate clause]" : "";
    log(`  ${c}: ${nums.length} issues → ${nums.map((n) => "SLI-" + n).join(", ")}${flag}`);
  }
  log("");
  log("Uncovered PRD clauses (no spec/plan/issues yet):");
  log("  " + uncoveredClauses.join(", "));
  log("");
  log(`Off-ledger (Internal tooling — left UNTETHERED, will show as drift): ${offLedgerExisting.length}`);
  log("  " + offLedgerExisting.sort((a, b) => a - b).map((n) => "SLI-" + n).join(", "));
  log("");
  log(`Genuinely UNMAPPED (exist, not in tether map at all — NOT guessed): ${unmapped.length}`);
  log("  " + unmapped.sort((a, b) => a - b).map((n) => "SLI-" + n).join(", "));
  if (missingNums.length) {
    log("");
    log(`Named in tether map but no such issue exists (skipped): ${missingNums.length}`);
    log("  " + missingNums.sort((a, b) => a - b).map((n) => "SLI-" + n).join(", "));
  }
  if (conflicts.length) {
    log("");
    log("⚠ Issues named under more than one clause (first wins):");
    for (const c of conflicts) log(`  SLI-${c.num}: ${c.existing} (kept) vs ${c.alsoIn}`);
  }
  if (rowsMissingClause.length) {
    log("");
    log("⚠ Tether-map product rows with no parseable clause (issues left unmapped):");
    for (const r of rowsMissingClause) log(`  ${r.checkpoint}`);
  }

  // Sanity totals
  const totalIssues = allIssues.filter((i) => i.identifier !== PLAN_ISSUE_IDENTIFIER).length;
  log("");
  log("Totals (excluding SLI-1 itself):");
  log(`  total issues: ${totalIssues}`);
  log(`  tethered: ${tetheredNums.size}`);
  log(`  off-ledger drift: ${offLedgerExisting.length}`);
  log(`  unmapped drift: ${unmapped.length}`);
  const accounted = tetheredNums.size + offLedgerExisting.length + unmapped.length;
  log(`  accounted: ${accounted} ${accounted === totalIssues ? "✓" : "✗ MISMATCH"}`);

  if (!APPLY) {
    log("");
    log("DRY-RUN complete. No changes written. Re-run with --apply to write.");
    await closeDb(db);
    return;
  }

  // --- APPLY ---------------------------------------------------------------
  log("");
  log("APPLYING…");
  const svc = grandPlanService(db);

  async function ensureNode(
    tier: "prd" | "spec" | "plan",
    title: string,
    parentId: string | null,
  ): Promise<string> {
    const existing = await db
      .select()
      .from(grandPlanNodes)
      .where(
        and(
          eq(grandPlanNodes.companyId, SLIDEFORGE_COMPANY_ID),
          isNull(grandPlanNodes.projectId),
          eq(grandPlanNodes.tier, tier),
          eq(grandPlanNodes.title, title),
          parentId == null
            ? isNull(grandPlanNodes.parentId)
            : eq(grandPlanNodes.parentId, parentId),
        ),
      )
      .then((r) => r[0] ?? null);
    if (existing) return existing.id;
    const node = await svc.create({
      companyId: SLIDEFORGE_COMPANY_ID,
      projectId: null,
      parentId,
      tier,
      title,
    });
    return node.id;
  }

  // doc-root
  const rootId = await ensureNode("prd", DOC_ROOT_TITLE, null);
  await svc.attachDocument(rootId, prdDoc.documentId, prdDoc.latestRevisionId ?? null);
  let createdNodes = 0;
  let tetheredCount = 0;

  // clause nodes
  const clauseNodeId = new Map<string, string>();
  for (const c of allClauses) {
    const id = await ensureNode("prd", c, rootId);
    clauseNodeId.set(c, id);
  }

  // spec+plan for clauses with issues, then tether
  const planNodeIds: string[] = [];
  for (const c of clausesWithIssues) {
    const clauseId = clauseNodeId.get(c)!;
    const specId = await ensureNode("spec", `Spec — ${c}`, clauseId);
    if (specDoc) await svc.attachDocument(specId, specDoc.documentId, specDoc.latestRevisionId ?? null);
    const planId = await ensureNode("plan", `Plan — ${c}`, specId);
    if (planDoc) await svc.attachDocument(planId, planDoc.documentId, planDoc.latestRevisionId ?? null);
    planNodeIds.push(planId);

    const nums = [...(issueNumsByClause.get(c) ?? [])].filter((n) => issueByNum.has(n));
    for (const n of nums) {
      const issue = issueByNum.get(n)!;
      if (issue.grandPlanNodeId !== planId) {
        await db
          .update(issues)
          .set({ grandPlanNodeId: planId })
          .where(eq(issues.id, issue.id));
      }
      tetheredCount++;
    }
  }

  // rollup
  for (const planId of planNodeIds) {
    await recomputeGrandPlanRollupForNodeAndAncestors(db, planId);
  }

  log(`Tethered ${tetheredCount} issues.`);
  log("Rollup recomputed.");
  log("APPLY complete.");
  await closeDb(db);
}

async function closeDb(db: ReturnType<typeof createDb>) {
  // postgres-js client is reachable via the underlying session; end the process.
  // drizzle-pg keeps the connection open, so force-exit cleanly.
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
