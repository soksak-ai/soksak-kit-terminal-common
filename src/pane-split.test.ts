// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createPaneSplitHost } from "./pane-split";
import { leaf, panesOf, splitPane } from "./pane-split-tree";
import type { TerminalRenderer } from "./terminal-renderer";

function fakeRenderer(): TerminalRenderer {
  const element = document.createElement("div");
  element.className = "fake-term";
  element.dataset.node = "term"; // 렌더러가 노출하는 노드(코어 scanNodes 대상) — 실제 xterm/ghostty 와 동형
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
    host.setFocused(true);
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

  it("hides the retained active-pane indicator when the host transfers focus outside the view", async () => {
    const { container, opts } = setup();
    const host = await createPaneSplitHost(opts);
    await host.split("row");
    host.setFocused(true);
    const p0Host = container.querySelectorAll<HTMLElement>("[data-pane-overlay]")[0]
      .parentElement as HTMLElement;
    p0Host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(host.active()?.paneId).toBe("p0");
    expect(p0Host.querySelector<HTMLElement>("[data-pane-overlay]")!.style.borderColor).not.toBe(
      "transparent",
    );

    host.setFocused(false);

    // 명령 대상은 보존하지만, 실제 포커스가 다른 뷰에 있으므로 선택 테두리는 없어야 한다.
    expect(host.active()?.paneId).toBe("p0");
    const visible = [...container.querySelectorAll<HTMLElement>("[data-pane-overlay]")].filter(
      (overlay) => overlay.style.borderColor !== "transparent",
    );
    expect(visible).toHaveLength(0);
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
    // 아직 이 terminal view가 입력 포커스를 얻지 않았으므로 내부 활성 테두리는 표시하지 않는다.
    const overlays = [...container.querySelectorAll<HTMLElement>("[data-pane-overlay]")];
    expect(overlays.filter((o) => o.style.borderColor !== "transparent")).toHaveLength(0);
    // 실제 입력이 새 pane에 진입하면 정확히 그 pane 하나만 표시한다.
    const p1Host = overlays[1].parentElement as HTMLElement;
    host.setFocused(true);
    p1Host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlays.filter((o) => o.style.borderColor !== "transparent")).toHaveLength(1);
    expect(overlays[1].style.borderColor).not.toBe("transparent");
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

  it("scopes each pane's data-node by paneId so every pane is individually addressable", async () => {
    const { container, opts } = setup();
    const host = await createPaneSplitHost(opts);
    await host.split("row"); // p0, p1
    const nodes = [...container.querySelectorAll<HTMLElement>("[data-node]")]
      .map((el) => el.dataset.node)
      .filter((n) => n?.startsWith("term"));
    // base("term")는 유지하고 paneId 세그먼트로 유일화 — 두 pane 다 노출(충돌로 하나 유실 없음).
    expect(nodes).toContain("term/p0");
    expect(nodes).toContain("term/p1");
    expect(nodes).not.toContain("term"); // 충돌하는 원본 path 는 남지 않는다
  });

  it("sanitizes '~' in paneId to a NODE_PATH_RE-safe segment", async () => {
    const { container, opts } = setup();
    const host = await createPaneSplitHost({ ...opts, mintPaneId: () => "v9~3", restore: leaf("v9~3") });
    void host;
    const node = [...container.querySelectorAll<HTMLElement>("[data-node]")]
      .map((el) => el.dataset.node)
      .find((n) => n?.startsWith("term"));
    expect(node).toBe("term/v9.3"); // `~` → `.`
  });
});
