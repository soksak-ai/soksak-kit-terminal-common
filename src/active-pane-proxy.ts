// 활성 pane 위임 프록시 — 탭내 분할(PaneSplitHost)에서 뷰 하나가 여러 pane 을 담을 때, 뷰 단위로
// 등록되는 표면(명령 레지스트리·IO substrate)이 "지금 활성인 pane"에 닿게 하는 TerminalRenderer.
// 뷰는 이 프록시 하나를 등록하고, 프록시는 매 호출마다 host.active() 로 현재 활성 pane 에 위임한다
// — 활성이 바뀌어도(클릭·포커스) 재등록 없이 따라간다. dispose 는 no-op(pane 수명은 호스트 소유).
import type { PaneSplitHost } from "./pane-split";
import type { TerminalRenderer, TerminalSettings } from "./terminal-renderer";

export function createActivePaneProxy<S extends TerminalSettings = TerminalSettings>(
  host: PaneSplitHost,
): TerminalRenderer<S> {
  const active = () => host.active()?.renderer as TerminalRenderer<S> | undefined;
  const fallback = document.createElement("div"); // 활성 pane 이 아직 없을 때만 노출(마운트 경합 창)
  return {
    get element() {
      return active()?.element ?? fallback;
    },
    get restorePainted() {
      return active()?.restorePainted ?? false;
    },
    focus: () => active()?.focus(),
    prepareFocusTransfer: () => active()?.prepareFocusTransfer(),
    fit: () => active()?.fit(),
    sendInput: (data) => active()?.sendInput(data),
    readBuffer: (lines) => active()?.readBuffer(lines) ?? "",
    write: (data) => active()?.write(data),
    clear: () => active()?.clear(),
    dispose: async () => {}, // pane 수명은 split 호스트 소유 — 프록시는 아무것도 안 닫는다
    paste: (text) => active()?.paste?.(text),
    setScreenSuspended: (suspended) => active()?.setScreenSuspended?.(suspended),
    applySettings: (settings) => active()?.applySettings?.(settings),
    perfStats: () => {
      const r = active();
      if (!r?.perfStats) throw new Error("no active pane");
      return r.perfStats();
    },
    echoProbe: () => {
      const r = active();
      return r?.echoProbe ? r.echoProbe() : Promise.reject(new Error("no active pane"));
    },
  };
}
