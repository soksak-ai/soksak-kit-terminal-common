// soksak-kit-terminal-common — soksak 터미널 플러그인들의 공유 셸 로직.
// 렌더러(xterm / ghostty)는 각 플러그인이 소유하고, 렌더러-비의존 로직만 여기 산다.
// 첫 모듈: WebKit IME 애드온 — 의도적 구조적 타입(ITerminalLike)이라 특정 렌더러에 비의존.
export {
  WebkitImeAddon,
  type ITerminalLike,
  type ITerminalAddon,
  type WebkitImeAddonOptions,
  type IDisposable,
} from "./ime-webkit";
