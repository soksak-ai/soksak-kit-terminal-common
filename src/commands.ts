// 렌더러-무관 터미널 명령 — send·clear·resume. 대상은 레지스트리로 해소한다(지정 view 또는 첫 활성).
// ping(플러그인 정체성)·perf(렌더러별 계측)는 여기 없다 — 각 플러그인이 소유한다.
import type { PluginContext } from "./host-contract";
import type { TerminalRegistry } from "./terminal-registry";
import type { PaneSplitHost } from "./pane-split";

// claude 세션 id — RFC4122 UUID 화이트리스트(코어 ai_session::is_valid_session_id 와 동일 표준).
// PTY 로 들어가는 위험 작업이라 양쪽 게이트(defense-in-depth). UUID 엔 특수문자가 없어 셸 injection 0.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerTerminalCommands(ctx: PluginContext, registry: TerminalRegistry): void {
  const app = ctx.app;
  if (!app.commands) return;
  const sub = (d: { dispose(): void }) => ctx.subscriptions.push(d);
  const readHint = (d: { ok?: unknown; viewId?: unknown }, why: string) =>
    d.ok && typeof d.viewId === "string"
      ? [{ cmd: `sok term.read '{"pane":"${d.viewId}"}'`, why }]
      : [];

  // [규칙] 대상을 해소하는 모든 터미널 명령은 동일하게 registry.resolve(view) 로 해소한다 — view 지정
  // 시 그 뷰, 없으면 첫 활성. perf.* 와 send/clear/resume 이 같은 규칙을 지켜야 within-tab 위임
  // 프록시(뷰 하나가 여러 pane)가 명령을 활성 pane 으로 일관되게 전달한다.
  const VIEW_PARAM = {
    view: { type: "string" as const, description: "Target view id (omit = first active terminal)" },
  };

  sub(
    app.commands.register("send", {
      description: "Send text to a terminal PTY (target view, else the first active terminal).",
      triggers: { ko: "터미널 텍스트 전송 입력" },
      params: {
        text: { type: "string", description: "Text to send to the terminal", required: true },
        ...VIEW_PARAM,
      },
      returns: "{ ok, viewId? }",
      message: () => "터미널에 텍스트를 전송했습니다.",
      // 전송은 즉시 돌아온다 — 출력은 잠시 후 그 터미널을 core term.read 로 확인한다(pane=이 viewId).
      hint: (d) => readHint(d, "잠시 후 이 터미널을 읽어 출력을 확인할 수 있습니다."),
      handler: (p) => {
        const entry = registry.resolve(p.view);
        if (!entry) return { ok: false, code: "NO_TARGET", message: "no active terminal" };
        entry.renderer.sendInput(String(p.text ?? ""));
        return { ok: true, viewId: entry.viewId };
      },
    }),
  );

  sub(
    app.commands.register("clear", {
      description: "Clear a terminal screen (target view, else the first active terminal).",
      triggers: { ko: "터미널 지우기 클리어" },
      params: { ...VIEW_PARAM },
      returns: "{ ok, viewId? }",
      message: () => "터미널 화면을 지웠습니다.",
      handler: (p) => {
        const entry = registry.resolve(p.view);
        if (!entry) return { ok: false, code: "NO_TARGET", message: "no active terminal" };
        entry.renderer.clear();
        return { ok: true, viewId: entry.viewId };
      },
    }),
  );

  sub(
    app.commands.register("resume", {
      // [R9] 복원된 블록의 claude 세션을 이어간다 — 사용자 명시 액션만(auto-trigger 0). sessionId 는
      // UUID 화이트리스트로 엄격 검증해 위조 history·셸 injection 을 차단한다.
      description:
        "Resume a tracked claude session by its sessionId in a terminal (target view, else the first active). User-initiated only; the sessionId must be a valid UUID.",
      triggers: { ko: "세션 이어가기 재개 resume" },
      params: {
        session: { type: "string", description: "claude sessionId (UUID) to resume", required: true },
        ...VIEW_PARAM,
      },
      returns: "{ ok, session, viewId? }",
      message: (d) => `세션 ${d.session} 을 이어갑니다.`,
      hint: (d) => readHint(d, "잠시 후 이 터미널을 읽어 이어진 세션의 응답을 확인할 수 있습니다."),
      handler: (p) => {
        const sid = String(p.session ?? "").trim();
        if (!UUID_RE.test(sid)) {
          return { ok: false, code: "INVALID_INPUT", message: "invalid sessionId (UUID required)" };
        }
        const entry = registry.resolve(p.view);
        if (!entry) return { ok: false, code: "NO_TARGET", message: "no active terminal" };
        // 셸 프롬프트에 `claude --resume <uuid>` 입력+실행. UUID 라 shell injection 0. claude 고정.
        entry.renderer.sendInput(`claude --resume ${sid}\r`);
        return { ok: true, session: sid, viewId: entry.viewId };
      },
    }),
  );
}

// 탭내 pane 수명 명령 — split-pane(쪼개기)·close-pane(닫기). 둘 다 splitMode=within-tab 인 뷰만
// 대상이고 같은 호스트 해소를 쓴다. 두 플러그인이 같은 명령을 쓰므로 kit 이 명령 모양·i18n 을
// 소유하고, 대상 호스트 해소만 플러그인이 넘긴다(resolveHost: view 지정 시 그 뷰의 split 호스트,
// 없으면 첫 within-tab 뷰). 이 명령들이 곧 "탭내 분할 계약" — tmux-fake 같은 소비자가 leader 의
// splitMode 를 몰라도 이 명령을 시도(성공=within-tab, NO_TARGET=tab 폴백)해 모드를 자동 추종한다.
export function registerPaneCommands(
  ctx: PluginContext,
  resolveHost: (view: string | undefined) => { viewId: string; host: PaneSplitHost } | null,
): void {
  const app = ctx.app;
  if (!app.commands) return;
  const noHost = { ok: false as const, code: "NO_TARGET", message: "no within-tab split host (set splitMode=within-tab)" };

  ctx.subscriptions.push(
    app.commands.register("split-pane", {
      description:
        "Split the terminal view into an internal pane (within-tab split; requires splitMode=within-tab).",
      triggers: { ko: "터미널 탭내 분할 나누기" },
      params: {
        view: { type: "string", description: "Target view id (omit = first within-tab view)" },
        dir: { type: "string", description: "'right' (default) or 'down'" },
      },
      returns: "{ ok, viewId?, paneId? }",
      // message 는 성공 outcome 의 data 만 받는다(ok 는 봉투에 있고 여기 없다) — paneId 유무로 판정.
      message: (d) => (d.paneId ? `pane ${d.paneId} 을 분할했습니다.` : "분할 대상 없음"),
      handler: async (p) => {
        const target = resolveHost(typeof p.view === "string" && p.view ? p.view : undefined);
        if (!target) return noHost;
        const paneId = await target.host.split(p.dir === "down" ? "col" : "row");
        return { ok: true, viewId: target.viewId, paneId };
      },
    }),
  );

  ctx.subscriptions.push(
    app.commands.register("close-pane", {
      description: "Close an internal within-tab pane by its paneId.",
      triggers: { ko: "터미널 탭내 pane 닫기" },
      params: {
        view: { type: "string", description: "The view that owns the pane (omit = first within-tab view)" },
        pane: { type: "string", description: "The paneId to close", required: true },
      },
      returns: "{ ok, viewId?, paneId? }",
      message: (d) => (d.paneId ? `pane ${d.paneId} 을 닫았습니다.` : "닫을 pane 없음"),
      handler: async (p) => {
        const target = resolveHost(typeof p.view === "string" && p.view ? p.view : undefined);
        if (!target) return noHost;
        const paneId = String(p.pane ?? "");
        if (!paneId) return { ok: false, code: "INVALID_INPUT", message: "pane is required" };
        await target.host.close(paneId);
        return { ok: true, viewId: target.viewId, paneId };
      },
    }),
  );
}
