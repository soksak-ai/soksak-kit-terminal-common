// 탭내 분할의 순수 모델 — 한 터미널 뷰 내부를 여러 pane 으로 쪼개는 split 트리와 그 연산.
// 렌더링·PTY 는 여기 없다(순수·테스트 가능). leaf = pane id(문자열), split = 방향+비율+자식.
// 코어의 GroupNode(패널 분할)와 같은 대수지만, 이건 "한 뷰 안"의 pane 분할이다(탭분할 아님).

export type PaneTree =
  | { type: "leaf"; pane: string }
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: PaneTree[] };

export const leaf = (pane: string): PaneTree => ({ type: "leaf", pane });

const equalSizes = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

// 좌→우/상→하 순서의 pane id 수집.
export function panesOf(node: PaneTree): string[] {
  return node.type === "leaf" ? [node.pane] : node.children.flatMap(panesOf);
}

// target pane 을 dir 방향으로 쪼개 newPane 을 side("after"=우/하, "before"=좌/상)에 넣는다.
// splitId = 새(또는 재사용) split 노드 id. 이미 같은 dir 의 split 안이면 형제로 추가, 아니면 감싼다.
export function splitPane(
  node: PaneTree,
  target: string,
  newPane: string,
  dir: "row" | "col",
  side: "after" | "before",
  splitId: string,
): PaneTree {
  if (node.type === "leaf") {
    if (node.pane !== target) return node;
    const kids = side === "after" ? [node, leaf(newPane)] : [leaf(newPane), node];
    return { type: "split", id: splitId, dir, sizes: equalSizes(2), children: kids };
  }
  // 이 split 이 target 을 직접 자식(leaf)으로 갖고 방향이 같으면 형제로 끼운다(중첩 최소화).
  if (node.dir === dir) {
    const idx = node.children.findIndex((c) => c.type === "leaf" && c.pane === target);
    if (idx >= 0) {
      const at = side === "after" ? idx + 1 : idx;
      const children = [...node.children.slice(0, at), leaf(newPane), ...node.children.slice(at)];
      return { ...node, sizes: equalSizes(children.length), children };
    }
  }
  return { ...node, children: node.children.map((c) => splitPane(c, target, newPane, dir, side, splitId)) };
}

// pane 제거 — 빈 split 은 null, 자식 1개 남으면 붕괴(그 자식으로 대체), 자식 수 줄면 sizes 균등 재정규화.
export function removePane(node: PaneTree, pane: string): PaneTree | null {
  if (node.type === "leaf") return node.pane === pane ? null : node;
  const kids = node.children.map((c) => removePane(c, pane)).filter((c): c is PaneTree => c !== null);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { ...node, sizes: equalSizes(kids.length), children: kids };
}

// splitId 의 sizes 교체(자식 길이 일치 시만). 불변 — 새 객체 반환.
export function resizeSplit(node: PaneTree, splitId: string, sizes: number[]): PaneTree {
  if (node.type === "leaf") return node;
  if (node.id === splitId && sizes.length === node.children.length) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => resizeSplit(c, splitId, sizes)) };
}
