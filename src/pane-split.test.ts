// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createPaneSplitHost } from "./pane-split";
import type { TerminalRenderer } from "./terminal-renderer";

function fakeRenderer(): TerminalRenderer {
  const element = document.createElement("div");
  element.className = "fake-term";
  return {
    element,
    restorePainted: false,
    focus: vi.fn(),
    prepareFocusTransfer: vi.fn(),
    fit: vi.fn(),
    sendInput: vi.fn(),
    readBuffer: () => "",
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

function setup() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let seq = 0;
  const created: string[] = [];
  const onEmpty = vi.fn();
  return {
    container,
    onEmpty,
    created,
    opts: {
      container,
      createRenderer: async (paneId: string) => {
        created.push(paneId);
        return fakeRenderer();
      },
      mintPaneId: () => `p${seq++}`,
      onEmpty,
    },
  };
}

describe("createPaneSplitHost", () => {
  it("starts with a single pane holding one renderer", async () => {
    const { container, opts, created } = setup();
    const host = await createPaneSplitHost(opts);
    expect(created).toEqual(["p0"]);
    expect(container.querySelectorAll(".fake-term").length).toBe(1);
    expect(host.entries().map(([id]) => id)).toEqual(["p0"]);
    expect(host.active()?.paneId).toBe("p0");
  });

  it("split adds a pane, a flex group, and a divider between them", async () => {
    const { container, opts } = setup();
    const host = await createPaneSplitHost(opts);
    const newId = await host.split("row");
    expect(newId).toBe("p1");
    expect(container.querySelectorAll(".fake-term").length).toBe(2);
    const group = container.firstElementChild as HTMLElement;
    expect(group.style.flexDirection).toBe("row");
    // 자식 = host, divider, host (3)
    expect(group.children.length).toBe(3);
    expect(host.active()?.paneId).toBe("p1"); // 새 pane 이 활성
  });

  it("close removes a pane and collapses back to a single pane", async () => {
    const { container, opts } = setup();
    const host = await createPaneSplitHost(opts);
    await host.split("row");
    await host.close("p1");
    expect(container.querySelectorAll(".fake-term").length).toBe(1);
    expect(host.entries().map(([id]) => id)).toEqual(["p0"]);
  });

  it("closing the last pane fires onEmpty", async () => {
    const { opts, onEmpty } = setup();
    const host = await createPaneSplitHost(opts);
    await host.close("p0");
    expect(onEmpty).toHaveBeenCalledTimes(1);
  });

  it("preserves renderer instances across a split (moves host divs, no recreate)", async () => {
    const { container, opts, created } = setup();
    const host = await createPaneSplitHost(opts);
    const before = host.entries().find(([id]) => id === "p0")![1];
    await host.split("col");
    const after = host.entries().find(([id]) => id === "p0")![1];
    expect(after).toBe(before); // 같은 렌더러 인스턴스 — 재생성 0
    expect(created).toEqual(["p0", "p1"]); // p0 은 한 번만 생성
    expect(container.querySelectorAll(".fake-term").length).toBe(2);
  });
});
