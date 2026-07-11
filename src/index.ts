// soksak-kit-terminal-common — soksak 터미널 플러그인들의 공유 셸 로직.
// 렌더러(xterm / ghostty)는 각 플러그인이 소유하고, 렌더러-비의존 로직만 여기 산다.
//
// [규칙] 모듈 편입 기준: 두 소비자(xterm·ghostty)의 실요구가 실기기에서 확정된 것만.
// WebKit IME 애드온은 편입했다가 철회됐다(2026-07-11) — 구조적 타입은 부착 가능성일 뿐,
// 가드 내용이 xterm 의 조합 소유권(표준 경로를 CompositionHelper 에 위임) 전제라
// 조합을 자체 소유하는 ghostty-web 에 직부착하면 이중 처리로 악화(실기기 확인).
// IME 는 렌더러별 소유가 맞다. 공통 추출은 양쪽 구현이 완성된 뒤 실제 중복만.
export {};
