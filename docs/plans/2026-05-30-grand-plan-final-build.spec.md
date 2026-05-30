# Grand Plan — Final Build (original spec, caveman + grandma)

References hub: https://docs.paperclip.ing · Governance: https://paperclip.ing/#governance-section

## 1. New table: grand_plan_nodes 🆕
Tree shape. PRD on top, spec under, plan under. Each row points at one doc. Copy how goals table points at itself.
Columns: id, companyId, projectId, parentId, tier, title, documentId, sourceRevisionId, reconcileState, rollupPercent, ownerAgentId, timestamps.
Reference: packages/db/src/schema/goals.ts (tree pattern to copy).

## 2. Plan text = reuse existing docs ♻️
No new doc store. Paperclip already keeps documents AND remembers every version. The 5 docs become the text inside the tree boxes. Don't rewrite.
Reference: packages/db/src/schema/documents.ts and document_revisions.ts (auto-versioning).

## 3. One new column on issues: grandPlanNodeId 🆕(column)/♻️(table)
Add one link on each issue → points at its tree box. Throw away old trick of writing clause-ID words in description text. Real link, not loose words. Touch nothing else on the issue.
Reference: packages/db/src/schema/issues.ts — add the column, touch nothing else.

## 4. Migration ♻️(workflow)
Run pnpm db:generate. Then pnpm db:migrate. Robot writes the database change. No hand-written SQL.
Reference: README "Development" section, pnpm db:generate / pnpm db:migrate.

## 5. Enforce "no issue outside plan" ♻️(chokepoint)/🆕(guard)
Every new issue must pass through one gate. No tree box? Two choices: dump it in "unanchored" box AND show as drift, or open plan-change request. Never let it sneak in quiet.
Reference: issue-creation logic in server/src/services/issues.ts.

## 6. Cascade when PRD changes 🆕(service)/♻️(approvals) — YOU APPROVE
PRD change → new version made. Robot walks down tree, marks every box built from old version "parent changed." Owner agent drafts fix. Then agent asks Lyndsay. Yes → fix goes live. No → agent retries with her note. Agent does NOT change the plan on its own.
Reference: document_revisions.ts (the "stale" trip); approvals.ts + issue_approvals.ts (approval desk; new type string "grand_plan_reconcile", no table change).

## 7. Live progress rollup ♻️(hook)/🆕(function)
Every finished issue passes through ONE spot. When issue done, climb tree, update every box above. Plan → spec → PRD all tick up. Same moment, no waiting.
Reference: applyStatusSideEffects in server/src/services/issues.ts.

## 8. Keep what your engineer already built ✅(keep, don't rebuild)
PM-as-Steward + gate = keep (built from blockers + wake + approvals). 4 owners = keep, store as ownerAgentId on each box. 5 docs = keep, become box contents.
Reference: issue_blockers + the issue_blockers_resolved wake; ownership → ownerAgentId (added in section 1).

## 9. Kill the localStorage pin 🔧(replace hack)
Old "active plan" guessed in browser which issue had the PRD doc. Brittle. Now Grand Plan root is a real tree row where tier='prd'. Ask the server. No browser guessing. Reconcile with SLI-123 and the new sidebar before they fight.
Reference: the sidebar component ("Active plan" nav entry) + the in-review SLI-123 change to reconcile.
