# soksak-kit-terminal-common — 계약 (단일 진실)

터미널 프론트엔드 플러그인(`soksak-plugin-terminal-xterm`, `soksak-plugin-terminal-ghostty`)이
공유하는 **렌더러-비의존 로직과 계약**의 단일 진실. 이 문서가 규칙이다. 구현은 이 문서를 지킨다.

## 0. 왜 있는가

두 터미널 플러그인은 렌더러(xterm.js / ghostty-web)만 다르고 나머지 대부분이 같다. 실측 중복:
`host.ts` ~90%, `restore.ts` ~98%, 창전환 포커스-팔로우·테마 계약 읽기·ANSI 팔레트가 각 플러그인에
복붙돼 있었다. 복붙은 한쪽만 고쳐지는 표류를 낳는다. 공통을 kit 한 곳으로 모으고, 렌더러-특정은
kit이 정한 계약을 각 플러그인이 구현하게 한다.

## 1. 원칙 (무너뜨리지 않는다)

- **P1 렌더러-비의존만 kit에.** xterm.js / ghostty-web 의 타입·내부 API 에 닿는 코드는 플러그인이 소유한다.
- **P2 편입은 실증으로만.** 두 소비자(xterm·ghostty)가 실제로 쓰고 실기기에서 확정된 것만 편입한다.
  투기적 편입 금지 — 구조적 타입이 "부착 가능"해 보여도 실요구가 아니면 넣지 않는다(IME 편입→철회 선례).
- **P3 계약 우선.** 코드 공유가 불가한 렌더러-특정 관심사도 kit 이 **인터페이스(계약)** 를 정의하고,
  양쪽 플러그인이 그 계약을 구현한다. 그래서 두 플러그인은 **동일한 파일 체계**를 갖는다.
- **P4 단일 진실.** 각 로직·계약은 kit 에 한 곳만. 플러그인 간 복붙 금지.
- **P5 코어 무지 유지.** 이 계약은 코어를 한 줄도 고치지 않는다(코어는 program-무지, terminal-seam 이후).

## 2. `TerminalRenderer` 계약 (P3 핵심)

렌더러 인스턴스가 지켜야 하는 최소 표면. kit 의 공통 로직(명령·포커스·복원·마운트·분할)은
이 계약에만 의존한다 — 특정 렌더러를 모른다.

```ts
export interface TerminalRenderer {
  /** 이 렌더러의 마운트 루트. 분할 호스트가 pane div 로 이동/배치한다. */
  readonly element: HTMLElement;
  /** 마운트 시 복원 화면을 스스로 그렸는가(warm/cold). true 면 명령-블록 floor 를 겹치지 않는다. */
  readonly restorePainted: boolean;
  focus(): void;
  /** 다른 뷰가 포커스를 받기 전에 휘발성 IME 상태를 commit 한다(구현은 렌더러별). */
  prepareFocusTransfer(): void;
  fit(): void;
  sendInput(data: string): void;
  readBuffer(lines?: number): string;
  /** PTY 우회 화면 write(복원 텍스트 등 inert). */
  write(data: string): void;
  clear(): void;
  /** 화면 페인트 일시중단(vault lock). ACK 는 계속 보내 PTY 를 막지 않는다. */
  setScreenSuspended(suspended: boolean): void;
  applySettings(settings: TerminalSettings): void;
  dispose(): Promise<void>;
  /** 선택 — 계측(perf.stats/perf.echo 명령이 노출). 미지원이면 생략. */
  perfStats?(): PerfSnapshot;
  echoProbe?(): Promise<number>;
}

/** kit 이 렌더러를 생성/파괴하는 유일한 seam. 각 플러그인이 제공한다. */
export interface TerminalRendererFactory {
  create(opts: TerminalMountOptions): Promise<TerminalRenderer>;
}
```

## 3. 분류 — 무엇이 kit, 무엇이 플러그인

| 관심사 | 위치 | 근거 |
|---|---|---|
| 코어 플러그인 API 타입 표면(PluginContext·view 계약·app.pty·app.terminal) | **kit 계약** `host-contract.ts` | 렌더러 무관, 양쪽 ~90% 동일 |
| `TerminalRenderer` / `TerminalRendererFactory` | **kit 계약** | P3 핵심 |
| 사이드카 스폰 + 복원 오케스트레이션 | **kit 코드** `restore.ts` | pty/사이드카 로직, 양쪽 ~98% 동일 |
| `send`·`clear`·`resume`·`ping` 명령 | **kit 코드** `commands.ts` | `TerminalRenderer` 상대 — ghostty 도 획득 |
| 창전환 포커스-팔로우(pending·activeElement·focus) | **kit 코드** `focus-coordinator.ts` | 양쪽 중복, 렌더러 무관 |
| command started/finished 활동 문장 | **kit 코드** `activity.ts` | 문자열은 플러그인 i18n 주입 |
| 테마 모드/배경 읽기 + ANSI 팔레트(색값) | **kit 코드** `theme-source.ts` | DOM 테마 계약 읽기·색값, 렌더러 무관 |
| 마운트·io 등록·블록 영속 배선 | **kit 코드** `mount-lifecycle.ts` | `TerminalRenderer` 상대 |
| split-mode 설정 스키마 | **kit 코드** `settings-schema.ts` | 스키마 공유, 등록은 각 플러그인 |
| within-tab 분할(PaneNode·분할호스트·multi-pty) | **kit 코드** `pane-split/` | 렌더러 무관, 각 플러그인은 factory 만 제공 |
| 렌더러 구현(xterm.js / ghostty-web 구동) | **플러그인** `renderer.ts` | 렌더러-특정 |
| 렌더러 테마 매핑(ITheme 등) | **플러그인** `theme-map.ts` | 렌더러 타입 |
| IME preedit | **플러그인** `ime.ts`(+kit `prepareFocusTransfer` 계약) | 렌더러-특정(kit 철회 선례), 계약만 공유 |
| focus 커서 오버라이드 / open 암묵포커스 억제 | **플러그인** (ghostty) | ghostty-web 내부 API |

## 4. 통일 파일 체계 (P3·P4)

두 플러그인은 동일 파일명 레이아웃을 갖는다. 공통은 kit, 렌더러-특정은 동일 이름의 파일로.

```
kit/src/     host-contract.ts · terminal-renderer.ts · restore.ts · commands.ts
             focus-coordinator.ts · mount-lifecycle.ts · activity.ts
             theme-source.ts · settings-schema.ts · pane-split/ · index.ts
xterm/src/   renderer.ts · theme-map.ts · ime.ts · plugin-entry.ts(얇게)
ghostty/src/ renderer.ts · theme-map.ts · ime.ts · cursor-focus.ts · plugin-entry.ts(얇게)
```

`renderer.ts` / `theme-map.ts` / `ime.ts` / `plugin-entry.ts` 는 양쪽 동일 이름. 나머지는 kit 이 소유한다.

## 5. within-tab 분할 (탭내 분할)

한 view(터미널 탭) 내부를 여러 pane 으로 쪼갠다(tmux 처럼, 탭바는 하나). 코어의 `panel.split`(=탭분할,
별도 panel)과 구분된다. 이 기능은 kit 이 소유한다 — `PaneNode`(pane id 들의 split tree) + 명령형 분할
컨테이너(divider 드래그·resize) + multi-pty 생명주기. 각 플러그인은 `TerminalRendererFactory` 만 제공한다.
과거 코어 내장 터미널의 `PaneTree`(git `11c3681e` 도입, `923f841a` 제거)가 알고리즘 참조 — 그 코드는
React·코어 결합이라 재사용하지 않고, kit 명령형 DOM 으로 새로 구현한다.

## 6. 설정

`splitMode: "tab" | "within-tab"`. 스키마는 kit(`settings-schema.ts`), 등록은 **각 터미널 플러그인**이
한다(터미널 설정=플러그인 소유 원칙). tmux-fake 는 leader 터미널의 설정을 `getGlobal(<terminalPluginId>,
"splitMode")` 로 **읽기만** 한다 — tmux-fake 는 설정을 소유하지 않는 소비자다.
