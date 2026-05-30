// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseCompany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockUseCompany(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarActivePlan", () => {
  let container: HTMLDivElement;

  async function render() {
    const { SidebarActivePlan } = await import("./SidebarActivePlan");
    const root = createRoot(container);
    await act(async () => {
      root.render(<SidebarActivePlan />);
    });
    return root;
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

  it("links the Active plan entry to /grand-plan (not an issue) when a company is selected", async () => {
    mockUseCompany.mockReturnValue({ selectedCompanyId: "company-1" });
    const root = await render();

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/grand-plan");
    expect(link?.textContent).toContain("Active plan");

    await act(async () => root.unmount());
  });

  it("shows a graceful muted entry (no link) when no company is selected", async () => {
    mockUseCompany.mockReturnValue({ selectedCompanyId: null });
    const root = await render();

    expect(container.querySelector("a")).toBeNull();
    const muted = container.querySelector('[aria-disabled="true"]');
    expect(muted?.textContent).toContain("Active plan");

    await act(async () => root.unmount());
  });
});
