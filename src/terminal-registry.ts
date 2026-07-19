// 활성 터미널 렌더러 레지스트리 — 플러그인이 마운트 시 렌더러를 등록하고 언마운트 시 해지한다.
// 렌더러-무관 명령(send/clear/resume)이 이 레지스트리로 대상 렌더러를 해소한다(지정 view 또는 첫 활성).
import type { TerminalRenderer } from "./terminal-renderer";

export interface TerminalRegistry {
  set(viewId: string, renderer: TerminalRenderer): void;
  delete(viewId: string): void;
  get(viewId: string): TerminalRenderer | undefined;
  /** 등록된 모든 터미널(등록 순). 전체 대상 명령(예: perf 스냅샷)용. */
  entries(): Array<[string, TerminalRenderer]>;
  /** 대상 미지정 명령용 — 첫 활성 터미널(등록 순). 없으면 null. */
  first(): { viewId: string; renderer: TerminalRenderer } | null;
  /** 지정 view 를 해소하거나(문자열), 미지정이면 첫 활성. 없으면 null. */
  resolve(view: unknown): { viewId: string; renderer: TerminalRenderer } | null;
}

export function createTerminalRegistry(): TerminalRegistry {
  const map = new Map<string, TerminalRenderer>();
  const first = (): { viewId: string; renderer: TerminalRenderer } | null => {
    const e = map.entries().next();
    return e.done ? null : { viewId: e.value[0], renderer: e.value[1] };
  };
  return {
    set: (id, r) => void map.set(id, r),
    delete: (id) => void map.delete(id),
    get: (id) => map.get(id),
    entries: () => [...map.entries()],
    first,
    resolve: (view) => {
      if (typeof view === "string" && view) {
        const r = map.get(view);
        return r ? { viewId: view, renderer: r } : null;
      }
      return first();
    },
  };
}
