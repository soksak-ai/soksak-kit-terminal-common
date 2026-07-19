// 분할 구조 영속 — within-tab 뷰의 PaneTree 를 코어 kv(앱 재시작·창 닫기 넘어 생존)에 뷰별로 저장/복원.
// remount(플러그인 리로드·앱 재시작) 시 이 트리로 pane 들을 되살린다(pane id 보존 → 세션 내용은
// per-pane 복원 경로가 채운다). 단일 pane 뷰는 트리를 저장하지 않는다(leaf 는 복원할 구조가 없음).
import type { PaneTree } from "./pane-split-tree";
import { isPaneTree } from "./pane-split-tree";

// 코어 app.data.kv 의 부분(구조적) — 이 스토어가 쓰는 것만.
interface KvLike {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
}

export interface PaneTreeStore {
  /** 저장된 트리(유효할 때만) 또는 null(신선·손상). */
  load(): Promise<PaneTree | null>;
  /** 구조 변경마다 호출(fire-and-forget). leaf(단일 pane)면 저장 대신 지운다 — 복원할 구조가 없다. */
  save(tree: PaneTree): void;
  /** 뷰가 비거나 닫힐 때 — 스테일 트리 제거. */
  clear(): void;
}

export function createPaneTreeStore(kv: KvLike, viewId: string): PaneTreeStore {
  const key = `paneTree:${viewId}`;
  return {
    async load() {
      try {
        const value = await kv.get(key);
        return isPaneTree(value) ? value : null;
      } catch {
        return null; // kv 실패(잠김 등)는 복원 없이 신선 마운트 — 라이브 동작 비차단
      }
    },
    save(tree) {
      // 단일 pane(leaf)은 복원할 구조가 없다 — 저장하면 다음 마운트가 leaf 를 "복원"해 mintPaneId
      // 를 건너뛰니, 그냥 지워 기본(단일 pane 신선 마운트) 경로로 둔다.
      if (tree.type === "leaf") {
        void kv.delete(key).catch(() => {});
        return;
      }
      void kv.set(key, tree).catch(() => {});
    },
    clear() {
      void kv.delete(key).catch(() => {});
    },
  };
}
