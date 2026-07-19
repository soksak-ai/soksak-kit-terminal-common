// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createPaneSplitHost } from "./pane-split";
import { leaf, panesOf, splitPane } from "./pane-split-tree";
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
    // 단일 pane 은 활성 표시 없음(탭 포커스로 충분).
    const overlay = container.querySelector<HTMLElement>("[data-pane-overlay]")!;
    expect(overlay.style.borderColor).toBe("transparent");
  });

  it("clicking a pane moves the active indicator to it (mousedown, not just focusin)", async () => {
    const { container, opts } = setup();
    const host = await createPaneSplitHost(opts);
    await host.split("row"); // p1 활성
    const paneHosts = [...container.querySelectorAll<HTMLElement>("[data-pane-overlay]")].map(
      (o) => o.parentElement as HTMLElement,
    );
    // p0 host 를 mousedown — 활성이 p0 으로 이동해야 한다(focusin 이 안 와도).
    const p0Host = container.querySelectorAll<HTMLElement>("[data-pane-overlay]")[0]
      .parentElement as HTMLElement;
    p0Host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(host.active()?.paneId).toBe("p0");
    const activeOverlays = paneHosts
      .map((h) => h.querySelector<HTMLElement>("[data-pane-overlay]")!)
      .filter((o) => o.style.borderColor && o.style.borderColor !== "transparent");
    expect(activeOverlays.length).toBe(1);
    // 그 활성 오버레이는 p0 host 안에 있어야 한다.
    expect(p0Host.querySelector<HTMLElement>("[data-pane-overlay]")!.style.borderColor).not.toBe(
      "transparent",
    );
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
    // divider 는 기본 1px 경계선(항상 보임) — 오버 때 밴드로 강조. 두꺼운 바 금지.
    expect((group.children[1] as HTMLElement).style.background).not.toBe("transparent");
    expect(host.active()?.paneId).toBe("p1"); // 새 pane 이 활성
    // 활성 pane 표시 — 2개 이상일 때 정확히 하나(활성)만 accent border 오버레이.
    const overlays = [...container.querySelectorAll<HTMLElement>("[data-pane-overlay]")];
    const active = overlays.filter((o) => o.style.borderColor && o.style.borderColor !== "transparent");
    expect(active.length).toBe(1);
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

  it("restore rebuilds the panes from a tree, preserving ids (no minting)", async () => {
    const { container, opts, created } = setup();
    const tree = splitPane(leaf("p-a"), "p-a", "p-b", "row", "after", "s1");
    const host = await createPaneSplitHost({
      ...opts,
      mintPaneId: () => {
        throw new Error("must not mint for restored panes");
      },
      restore: tree,
    });
    expect(created).toEqual(["p-a", "p-b"]); // 트리 순서로, id 보존
    expect(host.entries().map(([id]) => id)).toEqual(["p-a", "p-b"]);
    expect(host.snapshot()).toEqual(tree);
    expect(container.querySelectorAll(".fake-term").length).toBe(2);
  });

  it("onChange fires the new tree on split and close (persistence hook)", async () => {
    const { opts } = setup();
    const trees: string[][] = [];
    const host = await createPaneSplitHost({ ...opts, onChange: (t) => trees.push(panesOf(t)) });
    const id = await host.split("row");
    expect(trees.at(-1)).toEqual(["p0", id]); // split 직후 트리
    await host.close(id);
    expect(trees.at(-1)).toEqual(["p0"]); // close 직후(leaf 로 붕괴)
  });
});
