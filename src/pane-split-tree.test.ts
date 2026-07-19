import { describe, it, expect } from "vitest";
import { leaf, panesOf, splitPane, removePane, resizeSplit } from "./pane-split-tree";

describe("pane-split-tree", () => {
  it("splits a leaf into a two-pane split (after = right/bottom)", () => {
    const t = splitPane(leaf("p1"), "p1", "p2", "row", "after", "s1");
    expect(panesOf(t)).toEqual(["p1", "p2"]);
    expect(t).toMatchObject({ type: "split", dir: "row", sizes: [0.5, 0.5] });
  });

  it("before puts the new pane first", () => {
    const t = splitPane(leaf("p1"), "p1", "p2", "col", "before", "s1");
    expect(panesOf(t)).toEqual(["p2", "p1"]);
  });

  it("same-direction split adds a sibling instead of nesting", () => {
    let t = splitPane(leaf("p1"), "p1", "p2", "row", "after", "s1");
    t = splitPane(t, "p2", "p3", "row", "after", "s2"); // 같은 row → 형제로
    expect(panesOf(t)).toEqual(["p1", "p2", "p3"]);
    expect(t).toMatchObject({ type: "split", id: "s1", sizes: [1 / 3, 1 / 3, 1 / 3] });
    // 자식 3개 모두 leaf(중첩 split 없음)
    if (t.type === "split") expect(t.children.every((c) => c.type === "leaf")).toBe(true);
  });

  it("cross-direction split nests", () => {
    let t = splitPane(leaf("p1"), "p1", "p2", "row", "after", "s1");
    t = splitPane(t, "p2", "p3", "col", "after", "s2"); // 다른 방향 → p2 를 감싼다
    expect(panesOf(t)).toEqual(["p1", "p2", "p3"]);
    if (t.type === "split") {
      expect(t.dir).toBe("row");
      expect(t.children[1]).toMatchObject({ type: "split", dir: "col" });
    }
  });

  it("removePane collapses a single-child split and renormalizes sizes", () => {
    let t = splitPane(leaf("p1"), "p1", "p2", "row", "after", "s1");
    t = splitPane(t, "p2", "p3", "row", "after", "s2");
    const r2 = removePane(t, "p2");
    expect(r2 && panesOf(r2)).toEqual(["p1", "p3"]);
    expect(r2).toMatchObject({ sizes: [0.5, 0.5] }); // 균등 재정규화
    // 마지막 하나만 남으면 붕괴(leaf)
    const only = removePane(removePane(t, "p2")!, "p3");
    expect(only).toEqual({ type: "leaf", pane: "p1" });
    expect(removePane(leaf("p1"), "p1")).toBeNull(); // 유일 pane 제거 = null
  });

  it("resizeSplit replaces sizes only when the child count matches", () => {
    let t = splitPane(leaf("p1"), "p1", "p2", "row", "after", "s1");
    t = resizeSplit(t, "s1", [0.7, 0.3]);
    expect(t).toMatchObject({ sizes: [0.7, 0.3] });
    expect(resizeSplit(t, "s1", [0.5, 0.3, 0.2])).toMatchObject({ sizes: [0.7, 0.3] }); // 불일치 무시
  });
});
