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

const DIVIDER_PX = 1; // 시각 선 폭(레이아웃 공간). 드래그 hit 영역은 절대위치로 따로 넓힌다.
const DRAG_PAD = 4; // hit 영역이 선 양옆으로 겹치는 폭(레이아웃 불변).
const MIN_FRAC = 0.05;

// paneId(`${viewId}~n`)를 코어 data-node path 세그먼트로 안전하게 — NODE_PATH_RE 는 [a-z0-9.-] 만
// 허용해 `~` 를 못 쓴다. 소문자화 + 비허용 문자를 `.` 로, 양끝 `.` 제거(세그먼트는 [a-z0-9] 로 시작).
function paneNodeSegment(paneId: string): string {
  return paneId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

// 이 pane 안의 노출 노드(data-node)를 pane 별로 유일하게 만든다 — 코어 동적목록 규약 `<base>/<key>`
// 를 그대로 써서 base(첫 세그먼트, 매니페스트 선언·conformance) 뒤에 paneId 세그먼트를 끼운다:
// "terminal-xterm" → "terminal-xterm/v46.0". 안 하면 pane 마다 같은 path 가 충돌해 코어 scanNodes 가
// 하나만 남기고 나머지 pane dom 이 ui.tree 에서 사라진다. lazy 노드(생성 후 추가되는 것)는 이 시점
// 스냅샷 밖이라 스코프되지 않는다(현재 케이스에선 정적 terminal 노드가 핵심).
function scopePaneNodes(root: HTMLElement, paneId: string): void {
  const seg = paneNodeSegment(paneId);
  const els: HTMLElement[] = [];
  if (root.dataset.node) els.push(root);
  els.push(...root.querySelectorAll<HTMLElement>("[data-node]"));
  for (const el of els) {
    const path = el.dataset.node;
    if (!path) continue;
    const segs = path.split("/");
    if (segs[1] === seg) continue; // 멱등 — 이미 이 pane 으로 스코프됨
    el.dataset.node = [segs[0], seg, ...segs.slice(1)].join("/");
  }
}

export interface PaneSplitHost {
  /** 코어 view provider 경계가 전달한 실제 뷰 포커스 소유권. active pane 명령 대상과 직교한다. */
  setFocused(focused: boolean): void;
  /** 활성 pane 을 dir 방향으로 쪼갠다(after=우/하). 새 pane id 반환. */
  split(dir: "row" | "col"): Promise<string>;
  /** pane 을 닫는다. 마지막 pane 이면 onEmpty 를 부른다(뷰 전체 닫힘). */
  close(paneId: string): Promise<void>;
  /** 활성(포커스) pane. 명령 대상 해소용. */
  active(): { paneId: string; renderer: TerminalRenderer } | null;
  /** 모든 pane(등록 순). */
  entries(): Array<[string, TerminalRenderer]>;
  /** 현재 분할 구조(영속·복원용). pane id·방향·크기를 담은 순수 트리. */
  snapshot(): PaneTree;
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
  /** 있으면 이 트리로 재구축한다(pane id 보존 → 각 pane 세션 내용은 per-pane 복원 경로가 되살린다).
   *  단일 pane 뷰(leaf)면 초기 pane 하나로 마운트하는 것과 같다. mintPaneId 는 이 트리를 넘어선
   *  새 split 에만 쓰이니, 발급기의 seq 는 호출자가 복원 트리 뒤로 맞춰 넘긴다. */
  restore?: PaneTree;
  /** 구조 변경(split/close/resize 확정)마다 현재 트리를 알린다 — 호출자가 영속한다. */
  onChange?: (tree: PaneTree) => void;
}

export async function createPaneSplitHost(opts: PaneSplitOptions): Promise<PaneSplitHost> {
  const { container, createRenderer, mintPaneId, onEmpty, restore, onChange } = opts;
  const hosts = new Map<string, { renderer: TerminalRenderer; host: HTMLElement }>();
  let tree: PaneTree;
  let activePane = "";
  // 명령 대상(activePane)과 현재 뷰의 실제 포커스 소유권은 서로 다른 상태다. 전자는 다른
  // 뷰로 이동해도 보존하지만, 활성 테두리는 이 뷰가 입력을 소유할 때만 표시한다.
  let viewFocused = false;
  const emitChange = (): void => onChange?.(tree);

  const wrapHost = (paneId: string, r: TerminalRenderer): HTMLElement => {
    const h = document.createElement("div");
    h.style.cssText =
      "position:relative;overflow:hidden;min-width:0;min-height:0;width:100%;height:100%";
    h.appendChild(r.element);
    // 이 pane 의 노출 노드(data-node)를 pane 별로 유일하게 — base(첫 세그먼트, 매니페스트 선언·
    // conformance) 뒤에 paneId 세그먼트를 끼운다. 안 하면 pane 마다 같은 path("terminal-xterm" 등)가
    // 충돌해 코어 scanNodes 가 하나만 남기고 나머지 pane 의 dom 이 ui.tree 에서 사라진다(주소 불가).
    scopePaneNodes(r.element, paneId);
    // 활성 표시 오버레이 — 터미널 위(z-index)에 border 로 그린다. outline 은 canvas 에 가려 안
    // 보이므로 오버레이가 확실하다. pointer-events:none 로 클릭은 터미널로 통과.
    const overlay = document.createElement("div");
    overlay.dataset.paneOverlay = "1";
    overlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;box-sizing:border-box;z-index:3;border:2px solid transparent;transition:border-color 0.1s";
    h.appendChild(overlay);
    // 활성 pane 추적 — focusin(키보드 포커스)만으로는 ghostty textarea 위치에 따라 host 까지
    // 안 올 수 있어, mousedown(클릭)도 함께 잡는다. capture 단계(divider 는 host 밖이라 무관).
    const activate = (): void => {
      if (activePane === paneId) return;
      activePane = paneId;
      applyActiveStyle();
    };
    h.addEventListener("focusin", activate, true);
    h.addEventListener("mousedown", activate, true);
    return h;
  };

  // 활성 pane 표시 — pane 이 2개 이상일 때만 활성 pane 오버레이에 accent border. 단일 pane 은
  // 탭 포커스로 충분하므로 표시하지 않는다. tmux 의 활성-pane 테두리와 같은 역할.
  function applyActiveStyle(): void {
    const multi = hosts.size > 1;
    for (const [id, { host }] of hosts) {
      const overlay = host.querySelector<HTMLElement>("[data-pane-overlay]");
      if (overlay) {
        overlay.style.borderColor =
          multi && viewFocused && id === activePane
            ? "var(--pane-active-color, rgba(96,165,250,0.9))"
            : "transparent";
      }
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
    // divider = 1px 시각 선(경계 마커)만 flex 공간을 차지한다. 그래서 양옆 pane 이 이 선에 딱 붙고,
    // 활성 pane border(=pane 가장자리)와 갭이 없다. 드래그 hit 영역은 절대위치로 선 양옆으로 넓혀
    // 겹치되(레이아웃 불변) 투명하게 둔다.
    const d = document.createElement("div");
    const LINE = "var(--divider-line-color, rgba(128,128,128,0.35))";
    const ACCENT = "var(--divider-hover-color, rgba(96,165,250,0.85))";
    d.style.cssText = `flex:0 0 ${DIVIDER_PX}px;position:relative;background:${LINE};transition:background 0.12s,box-shadow 0.12s;z-index:2`;
    const hit = document.createElement("div");
    hit.style.cssText = horizontal
      ? `position:absolute;top:0;bottom:0;left:-${DRAG_PAD}px;right:-${DRAG_PAD}px;cursor:col-resize`
      : `position:absolute;left:0;right:0;top:-${DRAG_PAD}px;bottom:-${DRAG_PAD}px;cursor:row-resize`;
    d.appendChild(hit);
    let dragging = false;
    // 오버/드래그: 선을 accent 로 밝히고 box-shadow 로 폭 있는 밴드(레이아웃 불변).
    const hl = (on: boolean): void => {
      d.style.background = on ? ACCENT : LINE;
      d.style.boxShadow = on ? `0 0 0 1.5px var(--divider-band-color, rgba(96,165,250,0.3))` : "none";
    };
    hit.addEventListener("mouseenter", () => hl(true));
    hit.addEventListener("mouseleave", () => {
      if (!dragging) hl(false);
    });
    hit.addEventListener("mousedown", (e) => {
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
        hl(hit.matches(":hover")); // 드래그 끝 — 여전히 위에 있으면 밴드 유지, 아니면 기본 선
        tree = resizeSplit(tree, node.id, next); // 트리 영속(다음 split/close·재렌더가 이 sizes 로)
        for (const { renderer } of hosts.values()) renderer.fit();
        emitChange(); // 크기 확정 → 영속
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
    return d;
  };

  // ── 초기 구성 ── 복원 트리가 있으면 그 pane 들을(id 보존) 재구축, 없으면 단일 pane 으로 시작한다.
  const restorePanes = restore ? panesOf(restore) : [];
  if (restore && restorePanes.length > 0) {
    for (const paneId of restorePanes) {
      const r = await createRenderer(paneId);
      hosts.set(paneId, { renderer: r, host: wrapHost(paneId, r) });
    }
    tree = restore;
    activePane = restorePanes[0];
  } else {
    const first = mintPaneId();
    const r0 = await createRenderer(first);
    hosts.set(first, { renderer: r0, host: wrapHost(first, r0) });
    tree = leaf(first);
    activePane = first;
  }
  render();

  let splitSeq = 0;
  return {
    setFocused(focused) {
      if (viewFocused === focused) return;
      viewFocused = focused;
      applyActiveStyle();
    },
    async split(dir) {
      const target = hosts.has(activePane) ? activePane : panesOf(tree)[0];
      const paneId = mintPaneId();
      const r = await createRenderer(paneId);
      hosts.set(paneId, { renderer: r, host: wrapHost(paneId, r) });
      tree = splitPane(tree, target, paneId, dir, "after", `sp-${splitSeq++}`);
      activePane = paneId;
      render();
      emitChange(); // 구조 변경 → 영속
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
        onEmpty?.(); // 마지막 pane — 뷰가 비었다(호출자가 영속을 지운다)
        return;
      }
      tree = next;
      if (activePane === paneId) activePane = panesOf(tree)[0] ?? "";
      render();
      emitChange(); // 구조 변경 → 영속
    },
    active() {
      const e = hosts.get(activePane);
      return e ? { paneId: activePane, renderer: e.renderer } : null;
    },
    entries() {
      return [...hosts.entries()].map(([id, e]) => [id, e.renderer] as [string, TerminalRenderer]);
    },
    snapshot() {
      return tree;
    },
    async dispose() {
      for (const { renderer } of hosts.values()) await renderer.dispose().catch(() => {});
      hosts.clear();
      container.replaceChildren();
    },
  };
}
