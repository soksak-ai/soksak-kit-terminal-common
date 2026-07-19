import { describe, it, expect, vi } from "vitest";
import { createPaneTreeStore } from "./pane-tree-store";
import { leaf, splitPane } from "./pane-split-tree";

// 코어 kv 를 흉내내는 in-memory fake(get/set/delete 는 동기적으로 map 을 갱신).
function fakeKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: vi.fn(async (k: string) => map.get(k)),
    set: vi.fn(async (k: string, v: unknown) => void map.set(k, v)),
    delete: vi.fn(async (k: string) => map.delete(k)),
  };
}

const twoPane = () => splitPane(leaf("v1~0"), "v1~0", "v1~1", "row", "after", "s1");

describe("createPaneTreeStore", () => {
  it("saves a split tree under paneTree:<viewId> and loads it back", async () => {
    const kv = fakeKv();
    const store = createPaneTreeStore(kv, "v1");
    const tree = twoPane();
    store.save(tree);
    expect(kv.map.get("paneTree:v1")).toEqual(tree);
    expect(await store.load()).toEqual(tree);
  });

  it("save(leaf) clears instead of persisting — a single pane has no structure to restore", () => {
    const kv = fakeKv();
    kv.map.set("paneTree:v1", twoPane());
    const store = createPaneTreeStore(kv, "v1");
    store.save(leaf("v1~0"));
    expect(kv.map.has("paneTree:v1")).toBe(false);
  });

  it("load returns null for missing or corrupt data", async () => {
    const kv = fakeKv();
    const store = createPaneTreeStore(kv, "v1");
    expect(await store.load()).toBeNull(); // 없음
    kv.map.set("paneTree:v1", { type: "split", id: "s1", dir: "row", sizes: [0.5], children: [] }); // sizes≠children
    expect(await store.load()).toBeNull(); // 손상
    kv.map.set("paneTree:v1", { whatever: 1 });
    expect(await store.load()).toBeNull();
  });

  it("clear deletes the stored tree", () => {
    const kv = fakeKv();
    kv.map.set("paneTree:v1", twoPane());
    createPaneTreeStore(kv, "v1").clear();
    expect(kv.map.has("paneTree:v1")).toBe(false);
  });

  it("isolates views by key", async () => {
    const kv = fakeKv();
    createPaneTreeStore(kv, "vA").save(twoPane());
    expect(kv.map.has("paneTree:vA")).toBe(true);
    expect(await createPaneTreeStore(kv, "vB").load()).toBeNull();
  });
});
