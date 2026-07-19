// 렌더러-무관 터미널 명령 — send·clear·resume. 대상은 레지스트리로 해소한다(지정 view 또는 첫 활성).
// ping(플러그인 정체성)·perf(렌더러별 계측)는 여기 없다 — 각 플러그인이 소유한다.
import type { PluginContext } from "./host-contract";
import type { TerminalRegistry } from "./terminal-registry";

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

  sub(
    app.commands.register("send", {
      description: "Send text to the active terminal PTY.",
      triggers: { ko: "터미널 텍스트 전송 입력" },
      params: {
        text: { type: "string", description: "Text to send to the terminal", required: true },
      },
      returns: "{ ok, viewId? }",
      message: () => "터미널에 텍스트를 전송했습니다.",
      // 전송은 즉시 돌아온다 — 출력은 잠시 후 그 터미널을 core term.read 로 확인한다(pane=이 viewId).
      hint: (d) => readHint(d, "잠시 후 이 터미널을 읽어 출력을 확인할 수 있습니다."),
      handler: (p) => {
        const entry = registry.first();
        if (!entry) return { ok: false, code: "NO_TARGET", message: "no active terminal" };
        entry.renderer.sendInput(String(p.text ?? ""));
        return { ok: true, viewId: entry.viewId };
      },
    }),
  );

  sub(
    app.commands.register("clear", {
      description: "Clear the active terminal screen.",
      triggers: { ko: "터미널 지우기 클리어" },
      returns: "{ ok, viewId? }",
      message: () => "터미널 화면을 지웠습니다.",
      handler: () => {
        const entry = registry.first();
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
        "Resume a tracked claude session in the active terminal by its sessionId. User-initiated only; the sessionId must be a valid UUID.",
      triggers: { ko: "세션 이어가기 재개 resume" },
      params: {
        session: { type: "string", description: "claude sessionId (UUID) to resume", required: true },
      },
      returns: "{ ok, session, viewId? }",
      message: (d) => `세션 ${d.session} 을 이어갑니다.`,
      hint: (d) => readHint(d, "잠시 후 이 터미널을 읽어 이어진 세션의 응답을 확인할 수 있습니다."),
      handler: (p) => {
        const sid = String(p.session ?? "").trim();
        if (!UUID_RE.test(sid)) {
          return { ok: false, code: "INVALID_INPUT", message: "invalid sessionId (UUID required)" };
        }
        const entry = registry.first();
        if (!entry) return { ok: false, code: "NO_TARGET", message: "no active terminal" };
        // 셸 프롬프트에 `claude --resume <uuid>` 입력+실행. UUID 라 shell injection 0. claude 고정.
        entry.renderer.sendInput(`claude --resume ${sid}\r`);
        return { ok: true, session: sid, viewId: entry.viewId };
      },
    }),
  );
}
