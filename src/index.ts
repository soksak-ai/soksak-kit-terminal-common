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
