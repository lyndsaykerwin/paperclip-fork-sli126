/**
 * Shared PRD-clause parsing + diff helpers for the Grand Plan governance feature.
 *
 * A "PRD clause ID" looks like `PRD-story-1` / `PRD-later-3` — the pattern
 * `PRD-` followed by hyphen-separated lowercase-alphanumeric segments. Clause
 * IDs identify the per-clause Grand Plan nodes (each clause node's `title` IS
 * the clause ID). The migration script (`migrate-slideforge-grand-plan.ts`) and
 * the B2 PRD-change cascade both parse clauses, so the parser lives here once.
 */

const CLAUSE_RE = /PRD-[a-z0-9]+(?:-[a-z0-9]+)*/g;

/**
 * Extract every distinct PRD clause ID from a document body, in first-seen
 * order. Trailing hyphens (e.g. a clause written `PRD-story-1-`) are stripped.
 * Mirrors the original `parseClauseIdsInOrder` in the migration script.
 */
export function parsePrdClauseIdsInOrder(body: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  // RegExp with the global flag is stateful (lastIndex); construct a fresh one
  // per call so this helper is re-entrant.
  const re = new RegExp(CLAUSE_RE.source, "g");
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

export interface PrdClauseDiff {
  /** Clause IDs present in NEW but not OLD. */
  added: string[];
  /**
   * Clause IDs present in BOTH whose surrounding prose differs (best-effort
   * block heuristic — see below). A flag for human review, not a hard signal.
   */
  changed: string[];
  /** Clause IDs present in OLD but not NEW. */
  removed: string[];
}

/**
 * Split a document body into "blocks" and associate each block with the clause
 * IDs it mentions, then return clauseId -> concatenation of its blocks.
 *
 * BLOCK HEURISTIC (best-effort, documented limits below):
 *   - A new block starts at every markdown ATX heading line (one beginning with
 *     `#`) OR after a blank line. This means a body is sliced into heading
 *     sections and/or blank-line-separated paragraphs.
 *   - A block "mentions" a clause if that clause ID appears anywhere in the
 *     block's text.
 *   - A clause's signature = the in-document-order concatenation of every block
 *     that mentions it (joined with "\n"). Two clauses sharing a block both get
 *     that block's text in their signature.
 *
 * LIMITS (accepted because `changed` only triggers an extra review branch — a
 * false positive costs nothing but an extra human glance, never data loss):
 *   - If a clause is mentioned in many scattered blocks, editing ANY of them
 *     flags the clause. (Conservative — over-flags, never under-flags edits to
 *     prose physically near the clause.)
 *   - Reordering blocks that mention a clause changes its signature -> flagged,
 *     even if no words changed. Acceptable: a reorder is worth a human look.
 *   - Plain prose with no clause mention is ignored entirely (it anchors to no
 *     clause), so a pure intro-paragraph edit won't flag anything.
 */
function clauseSignatures(body: string): Map<string, string> {
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    const isHeading = /^\s*#/.test(line);
    const isBlank = line.trim() === "";
    if (isHeading) {
      // Start a new block at the heading.
      flush();
      current.push(line);
    } else if (isBlank) {
      // Blank line ends the current block.
      flush();
    } else {
      current.push(line);
    }
  }
  flush();

  const signatures = new Map<string, string[]>();
  for (const block of blocks) {
    const clauseIds = parsePrdClauseIdsInOrder(block);
    for (const id of clauseIds) {
      const list = signatures.get(id) ?? [];
      list.push(block);
      signatures.set(id, list);
    }
  }

  const out = new Map<string, string>();
  for (const [id, list] of signatures) {
    out.set(id, list.join("\n"));
  }
  return out;
}

/**
 * Diff the PRD clauses between an OLD and NEW document body.
 *   - `added`   = clause IDs in NEW but not OLD.
 *   - `removed` = clause IDs in OLD but not NEW.
 *   - `changed` = clause IDs in BOTH whose block-signature (see
 *     `clauseSignatures`) differs between the two bodies.
 * All three lists are in NEW-body / OLD-body first-seen order respectively and
 * are free of overlap (added/removed are membership-only; changed requires
 * presence in both).
 */
export function diffPrdClauses(oldBody: string, newBody: string): PrdClauseDiff {
  const oldClauses = parsePrdClauseIdsInOrder(oldBody);
  const newClauses = parsePrdClauseIdsInOrder(newBody);
  const oldSet = new Set(oldClauses);
  const newSet = new Set(newClauses);

  const added = newClauses.filter((c) => !oldSet.has(c));
  const removed = oldClauses.filter((c) => !newSet.has(c));

  const oldSigs = clauseSignatures(oldBody);
  const newSigs = clauseSignatures(newBody);
  const changed = newClauses.filter((c) => {
    if (!oldSet.has(c)) return false; // only clauses present in BOTH
    return (oldSigs.get(c) ?? "") !== (newSigs.get(c) ?? "");
  });

  return { added, changed, removed };
}
