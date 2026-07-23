// 코어 플러그인 API 중 터미널 플러그인이 쓰는 표면 — 단일 진실.
// soksak-plugin-spec 의 SoksakPluginApi 와 동형(별도 repo, 코어 소스 비의존). 두 터미널 플러그인이
// 각자 복붙하던 host.ts(xterm ~90% ≡ ghostty)를 여기 한 곳으로 모은다. 미선언 권한 표면은 런타임 undefined.

export interface Disposable {
  dispose(): void;
}

// 코어 viewRegistry.PluginViewContext 와 동형.
export interface PluginViewContext {
  projectId: string;
  root: string | null;
  paneId: string | null;
  viewId: string | null;
  // 마운트 시 1회 자동 실행할 명령(에이전트 프로그램 — 터미널이 PTY 로 실행). 없으면 null.
  command: string | null;
  /** 복원 seam(B3) — 재시작 복원 마운트면 관찰됐던 런타임(cwd·state). 새 뷰는 null. */
  restore?: { cwd: string | null; state?: unknown } | null;
  setBadge: (badge: number | "dot" | null) => void;
  setStatus: (status: { code: string; message?: string } | null) => void;
  setTitle: (title: string) => void;
}

export interface PluginViewProvider {
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
  setFocused?(container: HTMLElement, ctx: PluginViewContext, focused: boolean): void;
  prepareFocusTransfer?(container: HTMLElement, ctx: PluginViewContext): void;
  focus?(
    container: HTMLElement,
    ctx: PluginViewContext,
    request: { signal: AbortSignal },
  ): void;
  /** 줌 인텐트(코어 PLUGIN-CONTRACT §Zoom, 선택) — 뷰가 자기 관례로 응답(터미널=폰트 스텝).
   * 콘텐츠만 스케일하고 행 그리드(헤더·툴바 밴드)에는 손대지 않는다(줌 불변식). */
  zoom?(
    container: HTMLElement,
    ctx: PluginViewContext,
    action: "in" | "out" | "reset",
  ): void;
}

export interface ParamSpec {
  type: string;
  description?: string;
  required?: boolean;
}

export interface CommandHint {
  cmd: string;
  why: string;
}

export interface PluginCommandSpec {
  description: string;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  returns?: string;
  // 명령 결과는 명령마다 형태가 다르다(동적 API) — 포매터/힌트는 그 결과를 받는다.
  message?: (data: any) => string;
  /** Up to 3 suggested next commands, worded suggestively ("...할 수 있습니다"). */
  hint?: (data: any, ctx: PluginContext) => CommandHint[];
  handler: (params: Record<string, unknown>) => Promise<object> | object;
}

export interface CommandOutcome {
  ok: boolean;
  [k: string]: unknown;
}

// app.pty — 코어 PTY 구동 표면 (pty 권한 필요).
export interface PtyApi {
  /** PTY 생성 + 셸 스폰. 반환값 = ptyId. paneId 는 관찰 substrate·sok CLI 타깃 키(문자열 —
   *  코어가 SOKSAK_PANE 으로 주입하고 app.terminal/command 관찰을 이 키로 묶는다). */
  spawn(opts: {
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
    paneId?: string;
    /** 화면 복원 제어(배관) — 항상 명시: "none"=소비자가 화면 소유, {fromSeq}=raw 링을 그
     *  seq 부터 부착(레이스-프리 warm 핸드오프). */
    replay?: "none" | { fromSeq: number };
  }): Promise<number>;
  /** ptyId 에 텍스트/바이트 전송(키 입력). */
  write(id: number, data: string | Uint8Array): Promise<void>;
  /** 터미널 크기 변경 → PTY SIGWINCH. */
  resize(id: number, cols: number, rows: number): Promise<void>;
  /** 플로우 컨트롤 ACK (처리 완료 바이트 수). */
  ack(id: number, bytes: number): Promise<void>;
  /** PTY 닫기 + 정리. */
  close(id: number): Promise<void>;
  /** PTY 출력 구독(스폰 전 출력도 버퍼링 → 손실 없음). 반환=해지. */
  onData(id: number, cb: (data: Uint8Array) => void): Disposable;
  /** 셸 바이너리 경로 확인. 없으면 null. */
  which(bin: string): Promise<string | null>;
  /** 이 paneId 의 IO 핸들러(화면 읽기·입력 쓰기)를 코어 substrate 에 등록 → app.terminal.
   *  readBuffer/sendText 가 이 터미널에 닿는다. 마운트 시 등록, 언마운트 시 해지(Disposable). */
  registerIo(
    paneId: string,
    io: { readBuffer: (lines?: number) => string; sendInput: (data: string) => void },
  ): Disposable;
  /** 생존 서비스 사이드카의 서비스 소켓에 NDJSON 요청/응답 1왕복 릴레이(웹뷰 JS 는 UDS 불가).
   *  코어는 내용 불가지 — 요청/응답 JSON 통과 + 현재 창 label 스탬프. 연결 실패는 throw(사이드카
   *  사망 loud). {ok,code,data}/{ok:false,code,message} 봉투를 그대로 돌려준다. */
  sidecarRequest(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 이 pane 의 봉인 체크포인트를 앱 볼트로 개봉한 평문(base64)+altActive. 잠금=throw(fail-closed),
   *  블롭 없음=null. 죽은 세션 화면 cold 복원(사이드카 불요). */
  readSealedScreen(
    paneId: string,
  ): Promise<{ paintB64: string; altActive: boolean } | null>;
  /** 이 pane 에 라이브 데몬 세션이 있는가 — warm 복원 후보 판정(사이드카 무관·즉답, 데몬 안 띄움).
   *  false = 신선/cold/데몬 미가동 → 사이드카 rehydrate(재시도)를 안 태우고 즉시 진행. */
  paneAlive(paneId: string): Promise<boolean>;
}

// app.process — 외부 서브프로세스 spawn("process" 권한). 여기선 생존 서비스 사이드카를
// detached 로 스폰하는 데만 쓴다(cmd "sidecar:{name}", danger 게이트는 코어).
export interface ProcessApi {
  /** 매니페스트 sidecars[] 에서 이 계약을 구현한다고 선언한 유닛 이름 — 유닛 선택의 단일진실.
   *  번들에 유닛명을 상수로 굳히지 않기 위한 면이다(매니페스트만 바꿔도 유닛이 바뀐다). */
  sidecarName: (interfaceId: string) => string;
  spawn(
    cmd: string,
    args: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      envRemove?: string[];
      secretEnv?: Record<string, string>;
      /** setsid 생존 스폰 — "sidecar:{name}" 대상만 허용(코어 detached_gate). */
      detached?: boolean;
    },
  ): Promise<number>;
  onExit(handle: number, cb: (code: number) => void): Disposable;
  kill(handle: number): Promise<void>;
}

export interface PluginApi {
  pluginId: string;
  locale: () => string;
  commands?: {
    register: (name: string, spec: PluginCommandSpec) => Disposable;
    execute: (name: string, params?: Record<string, unknown>) => Promise<CommandOutcome>;
  };
  events: {
    on: (event: string, fn: (payload: unknown) => void) => Disposable;
  };
  // 활동 로그 자기기술 발행 — 터미널 명령 활동을 자기 i18n 문장으로 싣는다(코어 브리지 아님).
  activity: {
    publish: (
      kind: string,
      entry: { message: string; speak?: string } & Record<string, unknown>,
    ) => void;
  };
  // app.data — 코어 영속 저장. records(명령 블록 R1~R5) + kv(단일 값, 예: 뷰의 분할 구조). ns 는 코어가
  // 플러그인 id 로 강제, kv 는 앱 재시작·창 닫기 넘어 생존. "data" 권한 필요.
  data?: {
    kv: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      delete: (key: string) => Promise<boolean>;
      keys: (prefix?: string) => Promise<string[]>;
    };
    define: (collection: string, opts: { indexes?: string[]; fts?: string[] }) => Promise<void>;
    put: (
      collection: string,
      doc: Record<string, unknown>,
      opts?: { scope?: string; id?: string },
    ) => Promise<string>;
    query: (
      collection: string,
      opts?: {
        scope?: string;
        where?: Record<string, unknown>;
        order?: string;
        desc?: boolean;
        limit?: number;
      },
    ) => Promise<unknown[]>;
    retentionTrim: (collection: string, scope: string, cap: number) => Promise<number>;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
  };
  pty?: PtyApi;
  // 생존 서비스 사이드카 스폰용("process" 권한). 미선언이면 undefined(graceful).
  process?: ProcessApi;
  bus: {
    emit: (topic: string, payload: unknown) => void;
    on: (topic: string, fn: (payload: unknown) => void) => Disposable;
  };
  project: {
    current: () => { id: string; root: string | null } | null;
  };
  settings: {
    get: (key: string) => unknown;
    all: () => Record<string, unknown>;
    onChange: (cb: (all: Record<string, unknown>) => void) => Disposable;
  };
}

export interface PluginContext {
  app: PluginApi;
  manifest: unknown;
  dir: string;
  subscriptions: Disposable[];
}
