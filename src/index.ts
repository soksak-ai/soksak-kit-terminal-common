// soksak-kit-terminal-common — soksak 터미널 플러그인들의 공유 셸 로직.
// 렌더러(xterm / ghostty)는 각 플러그인이 소유하고, 렌더러-비의존 로직만 여기 산다.
// 규칙과 계약의 단일 진실은 docs/CONTRACT.ko.md.
//
// [편입 규칙] 두 소비자(xterm·ghostty)의 실요구가 실기기에서 확정된 것만. 투기적 편입 금지 —
// 구조적 타입이 부착 가능해 보여도 실요구가 아니면 넣지 않는다(WebKit IME 편입→철회, 2026-07-11).

export type {
  Disposable,
  PluginViewContext,
  PluginViewProvider,
  ParamSpec,
  CommandHint,
  PluginCommandSpec,
  CommandOutcome,
  PtyApi,
  ProcessApi,
  PluginApi,
  PluginContext,
} from "./host-contract";

export type {
  TerminalSettings,
  PerfSnapshot,
  TerminalRenderer,
} from "./terminal-renderer";

export { type Dict, makeTranslator } from "./i18n";

export {
  TERMINAL_CONTRACT,
  type ReplayControl,
  type RestoreOutcome,
  ensureSidecar,
  ensureSession,
  syncMirrorSize,
  orchestrateRestore,
} from "./restore";

export {
  type FocusRequest,
  type FocusTarget,
  type FocusCoordinator,
  createFocusCoordinator,
} from "./focus-coordinator";

export { terminalStartedActivity, terminalFinishedActivity } from "./activity";

export { type TerminalRegistry, createTerminalRegistry } from "./terminal-registry";
export { registerTerminalCommands, registerPaneCommands } from "./commands";

export {
  type MountTerminalViewOptions,
  type TerminalViewHandle,
  mountTerminalView,
} from "./mount-terminal-view";

export {
  type PaneTree,
  leaf,
  panesOf,
  isPaneTree,
  splitPane,
  removePane,
  resizeSplit,
} from "./pane-split-tree";

export { type PaneTreeStore, createPaneTreeStore } from "./pane-tree-store";

export {
  type PaneSplitHost,
  type PaneSplitOptions,
  createPaneSplitHost,
} from "./pane-split";

export { createActivePaneProxy } from "./active-pane-proxy";
