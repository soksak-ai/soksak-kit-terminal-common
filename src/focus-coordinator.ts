// 뷰별 포커스 코디네이터 — 렌더러-무관. 뷰 계약 focus() 는 렌더러가 마운트되기 전에 도착할 수
// 있으므로(비동기 스폰), 요청을 pending 으로 잡아 렌더러가 붙는 즉시 적용한다.
//
// [창전환 포커스 버그의 정정] 이전 구현들은 focus() 에서 container 가 DOM 포커스를 가졌으면
// (`container.contains(document.activeElement)`) 렌더러 포커스를 건너뛰었다. 창전환 시 코어가 DOM
// 포커스를 container 로 옮기면 그 검사가 참이 되지만, 렌더러(예: xterm textarea)의 포커스 대상은
// 따라오지 않는다 — 그래서 "DOM 은 왔는데 터미널이 포커스 안 되는" 증상이 났다. 정답: 취소 여부는
// AbortSignal 이 권위이고(포커스가 다른 뷰로 옮겨가면 코어가 abort), 렌더러가 준비되면 무조건
// focus() 한다(렌더러가 자기 포커스 대상을 안다, 재포커스는 멱등이라 안전). activeElement 검사 없음.

export interface FocusRequest {
  signal: AbortSignal;
}

// 코디네이터가 필요로 하는 최소 표면 — 렌더러 전체가 아니라 이 두 연산만(인터페이스 분리).
// TerminalRenderer 가 구조적으로 이를 만족한다.
export interface FocusTarget {
  focus(): void;
  prepareFocusTransfer(): void;
}

export interface FocusCoordinator {
  /** 뷰 계약 focus(request) 위임 — 렌더러 준비됐으면 즉시 포커스, 아니면 pending 보관. */
  request(req: FocusRequest): void;
  /** 렌더러 마운트 완료 — pending(미취소) 있으면 적용. */
  attach(target: FocusTarget): void;
  /** 뷰 계약 prepareFocusTransfer 위임 — 렌더러의 휘발성 IME 상태 commit. */
  prepareTransfer(): void;
  /** unmount 정리. */
  detach(): void;
}

export function createFocusCoordinator(): FocusCoordinator {
  let target: FocusTarget | null = null;
  let pending: FocusRequest | null = null;

  const apply = (): void => {
    if (!target || !pending || pending.signal.aborted) return;
    pending = null;
    target.focus();
  };

  return {
    request(req) {
      pending = req;
      apply();
    },
    attach(t) {
      target = t;
      apply();
    },
    prepareTransfer() {
      target?.prepareFocusTransfer();
    },
    detach() {
      target = null;
      pending = null;
    },
  };
}
