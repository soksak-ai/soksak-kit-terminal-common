// TerminalRenderer 계약 — kit 의 공통 로직(명령·포커스·복원·마운트·분할)이 의존하는 유일한 렌더러
// 표면. kit 은 특정 렌더러(xterm.js / ghostty-web)를 모른다. 각 플러그인이 이 계약을 구현한다(P3).
// 렌더러-특정 설정(예: xterm 의 webgl/dom)은 S 로 확장한다 — kit 은 공통 필드만 안다.

/** 두 렌더러 공통 설정 — 렌더러-무관 필드만. 플러그인이 S 로 확장한다. */
export interface TerminalSettings {
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  cursorBlink?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
}

/** 성능 카운터 스냅샷(pull) — 누적 카운터 + 스냅샷 시점 라이브 값. 두 스냅샷 차분으로 구간을 잰다. */
export interface PerfSnapshot {
  /** onData 로 도착한 누적 바이트(처리량 분자). */
  writtenBytes: number;
  /** 보낸 ACK(플로우 컨트롤) 횟수. */
  ackSent: number;
  /** write 콜백까지의 누적 지연(ms, 반올림) — 파싱 백로그. */
  writeCbLagMs: number;
  /** 재페인트 프레임 수. */
  rafFrameCount: number;
  /** 스냅샷 시점 라이브 값 — GPU 렌더러 활성 여부. */
  webglActive: boolean;
  /** 스냅샷 시점 라이브 값 — 스크롤백 행수. */
  scrollbackRows: number;
}

/**
 * 렌더러 인스턴스가 지켜야 하는 최소 표면. kit 공통 로직은 이 계약에만 의존한다.
 * S = 이 렌더러의 설정 타입(TerminalSettings 확장). 기본은 공통 설정.
 */
export interface TerminalRenderer<S extends TerminalSettings = TerminalSettings> {
  // ── 핵심(양쪽 렌더러가 반드시 제공 — 공유 로직은 이 부분에만 의존한다) ──
  /** 이 렌더러의 마운트 루트. 분할 호스트가 pane div 로 이동/배치한다. */
  readonly element: HTMLElement;
  /** 마운트 시 복원 화면을 스스로 그렸는가(warm rehydrate | cold 봉인 페인트). true 면 명령-블록
   *  floor(이력 repaint)를 겹치지 않는다 — 복원 프레임이 뷰포트 권위. */
  readonly restorePainted: boolean;
  focus(): void;
  /** 다른 뷰가 포커스를 받기 전에 휘발성 IME 상태를 commit 한다(구현은 렌더러별). */
  prepareFocusTransfer(): void;
  /** 컨테이너 크기에 맞춰 fit 후 PTY 에 크기 전파. */
  fit(): void;
  sendInput(data: string): void;
  readBuffer(lines?: number): string;
  /** PTY 우회 화면 write(복원 텍스트 등 inert, 재실행 0). */
  write(data: string): void;
  clear(): void;
  dispose(): Promise<void>;
  // ── 선택(렌더러가 지원하면 구현 — 공유 로직은 여기 의존하지 않는다) ──
  paste?(text: string): void;
  /** 화면 페인트 일시중단(vault lock 중). true 여도 ACK 는 계속 보내 PTY 를 막지 않는다. */
  setScreenSuspended?(suspended: boolean): void;
  applySettings?(settings: S): void;
  /** 계측(perf.stats 명령이 노출). */
  perfStats?(): PerfSnapshot;
  /** 입력→에코 왕복(ms) 1회 프로브(perf.echo 명령이 노출). */
  echoProbe?(): Promise<number>;
}
