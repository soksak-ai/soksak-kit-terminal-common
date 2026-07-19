// 터미널 뷰 마운트 오케스트레이션 — 렌더러-무관. 두 소비자(xterm·ghostty)의 plugin-entry 가
// 똑같이 하던 일을 여기 하나로 모은다: splitMode 를 읽어 (a) 단일 렌더러(탭분할은 코어 panel.split)
// 또는 (b) 탭내 pane 분할(kit split 호스트)로 배선하고, IO substrate·포커스 코디네이터·명령
// 레지스트리(within-tab 은 활성 pane 위임 프록시)를 걸고, dispose 로 전부 되감는다. 렌더러-특정
// 부분은 createRenderer 팩토리 하나뿐 — 플러그인이 자기 렌더러(+복원·IME·블록이력)를 만들어 넘긴다.
import type { PluginApi } from "./host-contract";
import type { FocusCoordinator } from "./focus-coordinator";
import type { TerminalRegistry } from "./terminal-registry";
import type { TerminalRenderer } from "./terminal-renderer";
import { createPaneSplitHost, type PaneSplitHost } from "./pane-split";
import { createActivePaneProxy } from "./active-pane-proxy";

export interface MountTerminalViewOptions {
  /** 렌더러/pane 이 들어갈 루트. 플러그인이 필요하면 미리 래핑해 넘긴다(예: xterm 의 .sk-term-wrap). */
  mountRoot: HTMLElement;
  viewId: string;
  /** true = 탭내 pane 분할(split 호스트), false = 단일 렌더러. splitMode 설정에서 플러그인이 계산. */
  withinTab: boolean;
  focus: FocusCoordinator;
  registry: TerminalRegistry;
  /** pane 마다 렌더러 생성. isFirst = 이 뷰의 첫 pane(에이전트 initialCommand 등 1회성 대상). */
  createRenderer: (paneId: string, isFirst: boolean) => Promise<TerminalRenderer>;
  setStatus: (status: { code: string; message?: string } | null) => void;
  /** 마지막 pane 이 닫혀 뷰가 비었을 때의 에러 메시지(플러그인 i18n). */
  emptyMessage: string;
}

export interface TerminalViewHandle {
  /** 탭내 분할이면 split 호스트(split-pane 명령이 읽는다), 아니면 null. */
  readonly splitHost: PaneSplitHost | null;
  dispose(): void;
}

export function mountTerminalView(
  app: PluginApi,
  opts: MountTerminalViewOptions,
): TerminalViewHandle {
  const { mountRoot, viewId, withinTab, focus, registry, createRenderer, setStatus, emptyMessage } =
    opts;
  const state = {
    splitHost: null as PaneSplitHost | null,
    single: null as TerminalRenderer | null,
    io: null as { dispose(): void } | null,
    disposed: false,
  };
  const fail = (err: unknown): void => {
    if (!state.disposed) setStatus({ code: "error", message: String(err) });
  };

  if (withinTab) {
    // 각 pane 은 자기 PTY(paneId=`${viewId}~n`). io/포커스/명령은 활성 pane 에 위임. 첫 pane 만 isFirst.
    let seq = 0;
    let first = true;
    void createPaneSplitHost({
      container: mountRoot,
      mintPaneId: () => `${viewId}~${seq++}`,
      createRenderer: async (paneId) => {
        const r = await createRenderer(paneId, first);
        first = false;
        // pane 개별 주소화 — 이 pane 을 자기 paneId 로 코어 IO substrate 에 직접 등록한다(viewId→활성
        // 프록시와 별개). 그래야 외부(teammate 등)가 활성 pane 과 무관하게 이 pane 을 겨냥해 읽고
        // 쓴다. 해지는 pane dispose 에 합성 — pane 이 닫히면(host.close) 렌더러 dispose 가 IO 도 푼다.
        const paneIo = app.pty?.registerIo?.(paneId, {
          readBuffer: (lines) => r.readBuffer(lines),
          sendInput: (data) => r.sendInput(data),
        });
        if (paneIo) {
          const origDispose = r.dispose.bind(r);
          r.dispose = async () => {
            paneIo.dispose();
            await origDispose();
          };
        }
        return r;
      },
      onEmpty: () => setStatus({ code: "error", message: emptyMessage }),
    })
      .then((h) => {
        if (state.disposed) {
          void h.dispose();
          return;
        }
        state.splitHost = h;
        state.io =
          app.pty?.registerIo?.(viewId, {
            readBuffer: (lines) => h.active()?.renderer.readBuffer(lines) ?? "",
            sendInput: (data) => h.active()?.renderer.sendInput(data),
          }) ?? null;
        focus.attach({
          focus: () => h.active()?.renderer.focus(),
          prepareFocusTransfer: () => h.active()?.renderer.prepareFocusTransfer(),
        });
        registry.set(viewId, createActivePaneProxy(h));
        setStatus(null);
      })
      .catch(fail);
  } else {
    // 단일 렌더러 — 탭분할은 코어 panel.split 이 담당(기본 경로).
    void createRenderer(viewId, true)
      .then((r) => {
        if (state.disposed) {
          void r.dispose(); // 마운트 완료 전 unmount — 즉시 정리(그 사이 스폰된 PTY 를 닫는다)
          return;
        }
        state.single = r;
        mountRoot.appendChild(r.element);
        state.io =
          app.pty?.registerIo?.(viewId, {
            readBuffer: (lines) => r.readBuffer(lines),
            sendInput: (data) => r.sendInput(data),
          }) ?? null;
        focus.attach({ focus: () => r.focus(), prepareFocusTransfer: () => r.prepareFocusTransfer() });
        registry.set(viewId, r);
        setStatus(null);
      })
      .catch(fail);
  }

  return {
    get splitHost() {
      return state.splitHost;
    },
    dispose() {
      state.disposed = true;
      focus.detach();
      state.io?.dispose();
      void state.single?.dispose();
      void state.splitHost?.dispose();
      registry.delete(viewId);
    },
  };
}
