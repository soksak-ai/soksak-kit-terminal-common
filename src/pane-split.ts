// 탭내 분할 런타임 — 한 터미널 뷰 컨테이너 안에서 PaneTree 를 명령형 DOM(중첩 flex + 드래그
// divider)으로 렌더하고, pane 마다 렌더러를 factory 로 만든다(multi-pty). 트리가 바뀌어도 렌더러
// 를 재생성하지 않고 host div 를 옮겨(appendChild) 세션을 보존한다. 렌더링·PTY 는 여기, 순수
// 트리 대수는 pane-split-tree.ts. 코어 program-무지 유지 — 이 호스트는 플러그인 안에서 돈다.
import type { TerminalRenderer } from "./terminal-renderer";
import {
  type PaneTree,
  leaf,
  panesOf,
  splitPane,
  removePane,
  resizeSplit,
} from "./pane-split-tree";

const DIVIDER_PX = 5;
const MIN_FRAC = 0.05;

export interface PaneSplitHost {
  /** 활성 pane 을 dir 방향으로 쪼갠다(after=우/하). 새 pane id 반환. */
  split(dir: "row" | "col"): Promise<string>;
  /** pane 을 닫는다. 마지막 pane 이면 onEmpty 를 부른다(뷰 전체 닫힘). */
  close(paneId: string): Promise<void>;
  /** 활성(포커스) pane. 명령 대상 해소용. */
  active(): { paneId: string; renderer: TerminalRenderer } | null;
  /** 모든 pane(등록 순). */
  entries(): Array<[string, TerminalRenderer]>;
  dispose(): Promise<void>;
}

export interface PaneSplitOptions {
  container: HTMLElement;
  /** pane 마다 렌더러 생성(플러그인이 자기 factory 로). paneId 는 호스트가 발급 — 각자 고유 PTY. */
  createRenderer: (paneId: string) => Promise<TerminalRenderer>;
  /** 고유 pane id 발급기(예: `${viewId}~${seq}`). */
  mintPaneId: () => string;
  /** 마지막 pane 이 닫혀 뷰가 비면 알린다. */
  onEmpty?: () => void;
}

export async function createPaneSplitHost(opts: PaneSplitOptions): Promise<PaneSplitHost> {
  const { container, createRenderer, mintPaneId, onEmpty } = opts;
  const hosts = new Map<string, { renderer: TerminalRenderer; host: HTMLElement }>();
  let tree: PaneTree;
  let activePane = "";

  const wrapHost = (paneId: string, r: TerminalRenderer): HTMLElement => {
    const h = document.createElement("div");
    h.style.cssText =
      "position:relative;overflow:hidden;min-width:0;min-height:0;width:100%;height:100%";
    h.appendChild(r.element);
    // 이 pane 에 포커스가 들어오면 활성 pane 으로. 명령 대상·시각 표시의 단일 사실.
    h.addEventListener(
      "focusin",
      () => {
        activePane = paneId;
        applyActiveStyle();
      },
      true,
    );
    return h;
  };

  // 활성 pane 표시 — pane 이 2개 이상일 때만 활성 pane 에 은은한 accent 아웃라인(inset). 단일
  // pane 은 탭 포커스로 충분하므로 표시하지 않는다. tmux 의 활성-pane 테두리와 같은 역할.
  function applyActiveStyle(): void {
    const multi = hosts.size > 1;
    for (const [id, { host }] of hosts) {
      host.style.outline =
        multi && id === activePane
          ? "1px solid var(--pane-active-color, rgba(96,165,250,0.75))"
          : "none";
      host.style.outlineOffset = "-1px";
    }
  }

  // 렌더 — 트리를 flex DOM 으로. leaf 는 보존된 host div, split 은 flex 그룹 + 사이 divider.
  const renderNode = (node: PaneTree): HTMLElement => {
    if (node.type === "leaf") return hosts.get(node.pane)!.host;
    const group = document.createElement("div");
    const horizontal = node.dir === "row";
    group.style.cssText = `display:flex;flex-direction:${horizontal ? "row" : "column"};width:100%;height:100%;min-width:0;min-height:0`;
    const childEls: HTMLElement[] = [];
    node.children.forEach((child, i) => {
      if (i > 0) group.appendChild(makeDivider(node, i, group, childEls));
      const el = renderNode(child);
      el.style.flex = `${node.sizes[i]} 1 0`;
      childEls.push(el);
      group.appendChild(el);
    });
    return group;
  };

  const render = (): void => {
    container.replaceChildren(renderNode(tree));
    for (const { renderer } of hosts.values()) renderer.fit();
    applyActiveStyle();
  };

  // divider 드래그 — gapIndex(=오른/아래 자식 인덱스) 양옆 자식의 비율을 조정한다. 드래그 중엔
  // 두 자식의 flex 를 직접 갱신(재렌더 없음 → host div 안 움직임, 세션 안전), mouseup 에 트리 영속.
  const makeDivider = (
    node: Extract<PaneTree, { type: "split" }>,
    gapIndex: number,
    group: HTMLElement,
    childEls: HTMLElement[],
  ): HTMLElement => {
    const horizontal = node.dir === "row";
    const d = document.createElement("div");
    // 기본은 은은한 1px 경계선 하나만(여기가 경계임을 안다). 마우스 오버·드래그 때 그 위에 폭 있는
    // 하이라이트 밴드가 뜬다(드래그 가능 구역). hit 영역은 DIVIDER_PX(cursor 로 안내).
    d.style.cssText = `flex:0 0 ${DIVIDER_PX}px;cursor:${horizontal ? "col-resize" : "row-resize"};display:flex;align-items:center;justify-content:center;background:transparent;transition:background 0.12s;z-index:1`;
    const line = document.createElement("div");
    line.style.cssText = horizontal
      ? "width:1px;align-self:stretch;background:var(--divider-line-color, rgba(128,128,128,0.35))"
      : "height:1px;width:100%;background:var(--divider-line-color, rgba(128,128,128,0.35))";
    d.appendChild(line);
    let dragging = false;
    const hl = (on: boolean): void => {
      d.style.background = on ? "var(--divider-hover-color, rgba(120,120,120,0.28))" : "transparent";
    };
    d.addEventListener("mouseenter", () => hl(true));
    d.addEventListener("mouseleave", () => {
      if (!dragging) hl(false);
    });
    d.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      hl(true);
      const rect = group.getBoundingClientRect();
      // flex 비율은 divider 픽셀을 뺀 "가용 공간"을 나눈다 — 마우스 이동 픽셀을 이 가용 공간으로
      // 환산해야 divider 가 포인터에 1:1 로 붙는다(그룹 전체로 나누면 느리게 움직여 이질감).
      const dividerCount = node.children.length - 1;
      const flexible = (horizontal ? rect.width : rect.height) - dividerCount * DIVIDER_PX;
      if (flexible <= 0) return;
      const start = horizontal ? e.clientX : e.clientY;
      const a = gapIndex - 1;
      const b = gapIndex;
      // baseline 은 트리 노드가 아니라 살아있는 DOM 의 현재 flex-grow 에서 읽는다 — 재렌더 없이도
      // 연속 드래그의 기준이 항상 최신이라 두 번째 드래그가 튀지 않는다(stale baseline 방지).
      const readGrow = (el: HTMLElement): number => parseFloat(el.style.flex) || 0;
      const next = childEls.map(readGrow);
      const startA = next[a];
      const startB = next[b];
      // 드래그 동안: pane 의 pointer-events 를 끊어 터미널(ghostty canvas)이 mousemove 를 먹지 않게
      // 한다 — 안 그러면 마우스가 pane 위를 지날 때 divider 갱신이 끊겨 포인터와 어긋난다. 텍스트
      // 선택도 차단. window 리스너는 capture 단계로 어떤 자식(캔버스)보다 먼저 받는다.
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      for (const { host } of hosts.values()) host.style.pointerEvents = "none";
      // 드래그 중 터미널 re-fit 을 rAF 로 throttle — 내용(canvas)이 divider 를 실시간으로 따라온다.
      let fitRaf = 0;
      const scheduleFit = (): void => {
        if (fitRaf) return;
        fitRaf = requestAnimationFrame(() => {
          fitRaf = 0;
          for (const { renderer } of hosts.values()) renderer.fit();
        });
      };
      const onMove = (ev: MouseEvent): void => {
        const cur = horizontal ? ev.clientX : ev.clientY;
        const df = (cur - start) / flexible;
        const sa = startA + df;
        const sb = startB - df;
        if (sa < MIN_FRAC || sb < MIN_FRAC) return;
        next[a] = sa;
        next[b] = sb;
        childEls[a].style.flex = `${sa} 1 0`;
        childEls[b].style.flex = `${sb} 1 0`;
        scheduleFit();
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        if (fitRaf) cancelAnimationFrame(fitRaf);
        document.body.style.userSelect = prevUserSelect;
        for (const { host } of hosts.values()) host.style.pointerEvents = "";
        dragging = false;
        hl(d.matches(":hover")); // 드래그 끝 — 여전히 위에 있으면 유지, 아니면 투명
        tree = resizeSplit(tree, node.id, next); // 트리 영속(다음 split/close·재렌더가 이 sizes 로)
        for (const { renderer } of hosts.values()) renderer.fit();
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
    return d;
  };

  // ── 초기 pane ──
  const first = mintPaneId();
  const r0 = await createRenderer(first);
  hosts.set(first, { renderer: r0, host: wrapHost(first, r0) });
  tree = leaf(first);
  activePane = first;
  render();

  let splitSeq = 0;
  return {
    async split(dir) {
      const target = hosts.has(activePane) ? activePane : panesOf(tree)[0];
      const paneId = mintPaneId();
      const r = await createRenderer(paneId);
      hosts.set(paneId, { renderer: r, host: wrapHost(paneId, r) });
      tree = splitPane(tree, target, paneId, dir, "after", `sp-${splitSeq++}`);
      activePane = paneId;
      render();
      r.focus(); // 새 pane 을 포커스 — 활성 표시가 여기로, 입력도 여기로.
      return paneId;
    },
    async close(paneId) {
      const entry = hosts.get(paneId);
      if (!entry) return;
      hosts.delete(paneId);
      await entry.renderer.dispose().catch(() => {});
      const next = removePane(tree, paneId);
      if (!next) {
        onEmpty?.();
        return;
      }
      tree = next;
      if (activePane === paneId) activePane = panesOf(tree)[0] ?? "";
      render();
    },
    active() {
      const e = hosts.get(activePane);
      return e ? { paneId: activePane, renderer: e.renderer } : null;
    },
    entries() {
      return [...hosts.entries()].map(([id, e]) => [id, e.renderer] as [string, TerminalRenderer]);
    },
    async dispose() {
      for (const { renderer } of hosts.values()) await renderer.dispose().catch(() => {});
      hosts.clear();
      container.replaceChildren();
    },
  };
}
