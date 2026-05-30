// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrandPlanView, GrandPlanViewNode } from "@paperclipai/shared";

const mockGrandPlanApi = vi.hoisted(() => ({ view: vi.fn() }));

vi.mock("../api/grandPlan", () => ({ grandPlanApi: mockGrandPlanApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeNode(over: Partial<GrandPlanViewNode> = {}): GrandPlanViewNode {
  return {
    id: "n",
    companyId: "company-1",
    projectId: null,
    parentId: null,
    tier: "prd",
    title: "node",
    documentId: null,
    sourceRevisionId: null,
    reconcileState: "current",
    rollupPercent: 0,
    ownerAgentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    children: [],
    issues: [],
    uncovered: false,
    ...over,
  };
}

const VIEW: GrandPlanView = {
  tree: makeNode({
    id: "root",
    title: "PRD root",
    children: [
      // Covered clause 1: spec -> plan -> issue (+ sub-issue)
      makeNode({
        id: "clause-1",
        tier: "prd",
        title: "Clause 1 covered",
        parentId: "root",
        rollupPercent: 60,
        children: [
          makeNode({
            id: "spec-1",
            tier: "spec",
            title: "Spec 1",
            parentId: "clause-1",
            children: [
              makeNode({
                id: "plan-1",
                tier: "plan",
                title: "Plan 1",
                parentId: "spec-1",
                issues: [
                  {
                    id: "iss-1",
                    identifier: "T-1",
                    title: "Tethered issue",
                    status: "in_progress",
                    children: [
                      { id: "sub-1", identifier: "T-1.1", title: "Sub issue", status: "done", children: [] },
                    ],
                  },
                ],
              }),
            ],
          }),
        ],
      }),
      // Uncovered clause 2
      makeNode({
        id: "clause-2",
        tier: "prd",
        title: "Clause 2 uncovered",
        parentId: "root",
        uncovered: true,
      }),
      // Clause 3 flagged for reconcile (PRD prose changed downstream)
      makeNode({
        id: "clause-3",
        tier: "prd",
        title: "Clause 3 needs reconcile",
        parentId: "root",
        reconcileState: "parent_changed",
      }),
    ],
  }),
  driftIssues: [
    { id: "drift-1", identifier: "D-1", title: "Orphan drift issue", status: "todo", children: [] },
  ],
};

describe("GrandPlan page", () => {
  let container: HTMLDivElement;

  async function render() {
    const { GrandPlan } = await import("./GrandPlan");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <GrandPlan />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function clickNode(testId: string) {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    if (!el) throw new Error(`missing ${testId}`);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders PRD clauses collapsed by default", async () => {
    mockGrandPlanApi.view.mockResolvedValue(VIEW);
    const root = await render();

    expect(container.textContent).toContain("Clause 1 covered");
    expect(container.textContent).toContain("Clause 2 uncovered");
    // collapsed: spec/plan/issue not yet visible
    expect(container.textContent).not.toContain("Spec 1");
    expect(container.textContent).not.toContain("Tethered issue");

    await act(async () => root.unmount());
  });

  it("expands a clause to reveal spec -> plan -> issue -> sub-issue", async () => {
    mockGrandPlanApi.view.mockResolvedValue(VIEW);
    const root = await render();

    await act(async () => clickNode("node-clause-1"));
    expect(container.textContent).toContain("Spec 1");

    await act(async () => clickNode("node-spec-1"));
    expect(container.textContent).toContain("Plan 1");

    await act(async () => clickNode("node-plan-1"));
    expect(container.textContent).toContain("Tethered issue");

    // expand the tethered issue to reveal its sub-issue
    const issueRow = [...container.querySelectorAll("div")].find(
      (d) => d.textContent?.includes("Tethered issue") && d.className.includes("cursor-pointer"),
    ) as HTMLElement;
    await act(async () => issueRow.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toContain("Sub issue");

    await act(async () => root.unmount());
  });

  it("shows the uncovered marker on a clause with no spec/plan", async () => {
    mockGrandPlanApi.view.mockResolvedValue(VIEW);
    const root = await render();

    const flag = container.querySelector('[data-testid="uncovered-flag"]');
    expect(flag?.textContent).toContain("no spec/plan yet");

    await act(async () => root.unmount());
  });

  it("shows the reconcile badge on a clause flagged parent_changed", async () => {
    mockGrandPlanApi.view.mockResolvedValue(VIEW);
    const root = await render();

    const flag = container.querySelector('[data-testid="reconcile-flag"]');
    expect(flag).not.toBeNull();
    expect(flag?.textContent).toContain("needs reconcile");

    await act(async () => root.unmount());
  });

  it("does not show the reconcile badge on a current clause", async () => {
    mockGrandPlanApi.view.mockResolvedValue(VIEW);
    const root = await render();

    // clause-1 is reconcileState 'current' (default) -> no badge inside its row.
    const clause1Row = container.querySelector('[data-testid="node-clause-1"]');
    expect(clause1Row?.querySelector('[data-testid="reconcile-flag"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders a red drift section listing untraceable issues", async () => {
    mockGrandPlanApi.view.mockResolvedValue(VIEW);
    const root = await render();

    const drift = container.querySelector('[data-testid="drift-section"]');
    expect(drift).not.toBeNull();
    expect(drift?.textContent).toContain("Drift");
    expect(drift?.textContent).toContain("no PRD component");

    // expand to reveal the orphan issue
    const header = drift!.querySelector("div") as HTMLElement;
    await act(async () => header.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toContain("Orphan drift issue");

    await act(async () => root.unmount());
  });

  it("shows an empty state when there is no grand plan and no drift", async () => {
    mockGrandPlanApi.view.mockResolvedValue({ tree: null, driftIssues: [] });
    const root = await render();

    expect(container.textContent).toContain("No grand plan yet");

    await act(async () => root.unmount());
  });
});
