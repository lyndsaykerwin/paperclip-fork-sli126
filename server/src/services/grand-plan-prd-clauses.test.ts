import { describe, expect, it } from "vitest";
import {
  diffPrdClauses,
  parsePrdClauseIdsInOrder,
} from "./grand-plan-prd-clauses.js";

describe("parsePrdClauseIdsInOrder", () => {
  it("returns clause IDs in first-seen order, deduped, trailing hyphens stripped", () => {
    const body = [
      "# PRD",
      "## PRD-story-1 — first",
      "Body mentions PRD-story-1 again.",
      "## PRD-story-2 — second",
      "Also references PRD-story-1- (trailing hyphen).",
    ].join("\n");
    expect(parsePrdClauseIdsInOrder(body)).toEqual(["PRD-story-1", "PRD-story-2"]);
  });

  it("returns [] for a body with no clause IDs", () => {
    expect(parsePrdClauseIdsInOrder("Just some prose, no clauses here.")).toEqual([]);
  });
});

describe("diffPrdClauses", () => {
  it("detects added clauses (in NEW, not OLD)", () => {
    const oldBody = "## PRD-story-1\nAlpha.";
    const newBody = "## PRD-story-1\nAlpha.\n## PRD-story-2\nBeta.";
    const { added, changed, removed } = diffPrdClauses(oldBody, newBody);
    expect(added).toEqual(["PRD-story-2"]);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("detects removed clauses (in OLD, not NEW)", () => {
    const oldBody = "## PRD-story-1\nAlpha.\n## PRD-story-2\nBeta.";
    const newBody = "## PRD-story-1\nAlpha.";
    const { added, changed, removed } = diffPrdClauses(oldBody, newBody);
    expect(added).toEqual([]);
    expect(removed).toEqual(["PRD-story-2"]);
    // PRD-story-1's surrounding prose is unchanged -> not flagged changed.
    expect(changed).toEqual([]);
  });

  it("detects a prose-only edit to one clause as changed (heading-block heuristic)", () => {
    const oldBody = [
      "## PRD-story-1",
      "The user can log in with email.",
      "## PRD-story-2",
      "The user can reset a password.",
    ].join("\n");
    const newBody = [
      "## PRD-story-1",
      "The user can log in with email OR a magic link.", // prose edited
      "## PRD-story-2",
      "The user can reset a password.", // unchanged
    ].join("\n");
    const { added, changed, removed } = diffPrdClauses(oldBody, newBody);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(changed).toEqual(["PRD-story-1"]);
  });

  it("does not flag a clause whose prose is identical even if other clauses move", () => {
    const oldBody = [
      "## PRD-story-1",
      "Login story.",
      "## PRD-story-2",
      "Reset story.",
    ].join("\n");
    // PRD-story-2 prose unchanged; PRD-story-1 prose changed; order preserved.
    const newBody = [
      "## PRD-story-1",
      "Login story, expanded with SSO.",
      "## PRD-story-2",
      "Reset story.",
    ].join("\n");
    const { changed } = diffPrdClauses(oldBody, newBody);
    expect(changed).toEqual(["PRD-story-1"]);
  });

  it("handles blank-line-separated paragraph blocks (no markdown headings)", () => {
    const oldBody = [
      "PRD-story-1: the dashboard shows revenue.",
      "",
      "PRD-story-2: the dashboard shows churn.",
    ].join("\n");
    const newBody = [
      "PRD-story-1: the dashboard shows revenue and margin.", // changed
      "",
      "PRD-story-2: the dashboard shows churn.", // unchanged
    ].join("\n");
    const { added, changed, removed } = diffPrdClauses(oldBody, newBody);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(changed).toEqual(["PRD-story-1"]);
  });

  it("returns empty diffs when bodies are identical", () => {
    const body = "## PRD-story-1\nAlpha.\n## PRD-story-2\nBeta.";
    expect(diffPrdClauses(body, body)).toEqual({ added: [], changed: [], removed: [] });
  });

  it("flags a clause changed when a block mentioning it is added", () => {
    const oldBody = "## PRD-story-1\nLogin.";
    const newBody = "## PRD-story-1\nLogin.\n\nExtra note about PRD-story-1 acceptance.";
    const { added, changed, removed } = diffPrdClauses(oldBody, newBody);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(changed).toEqual(["PRD-story-1"]);
  });
});
