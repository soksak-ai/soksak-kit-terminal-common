// 터미널 화면 복원 오케스트레이션 — 렌더러-비의존. 두 터미널 플러그인이 각자 복붙하던 것을
// 여기 한 곳으로 모은다(코드 ≡, 렌더러 무관 — 사이드카·PTY·봉인 블롭만 다룬다). 화면에 바이트를
// 쓰는 일은 렌더러가 하므로 writeInert 콜백으로 위임한다. 세 경로:
//   warm  라이브 미러가 있다 → 사이드카 rehydrate → inert 페인트 → from_seq 로 라이브 이음.
//   cold  죽은 세션 → 봉인 블롭 읽기(사이드카 불요) → inert 페인트 + 소실 고지 → 신선 셸.
//   fresh 복원할 것 없음 → 신선 스폰(프롬프트) + 명령-블록 floor.
// degraded: 사이드카 사망 loud 고지 + 리스폰 → 봉인 폴백. 봉인마저 없으면 degraded-fresh 고지 +
//   신선 셸(코어 폴백 없음). 무음 금지.
import type { PluginApi } from "./host-contract";
import { makeTranslator } from "./i18n";

// 복원이 화면·활동 로그에 찍는 사람 표면 텍스트 — restore 도메인이라 restore 와 함께 산다.
const EN = {
  "cold-restore-notice":
    "[Restored from a sealed checkpoint — the running process ended and was not restored; only the screen record was repainted]",
  "restore.degraded":
    "Could not reach the terminal restore sidecar — restore is degraded (falling back to the sealed record).",
  "restore.degraded-fresh":
    "Restore service is unavailable — starting a fresh shell without screen history.",
  "restore.cold-blocked": "Sealed screen restore is blocked; starting live only.",
  "sidecar.spawn-failed": "Failed to spawn the terminal restore sidecar.",
  "sidecar.subscribe-timeout":
    "The restore sidecar did not subscribe this session in time — restore fidelity is limited for this session.",
};
const KO = {
  "cold-restore-notice":
    "[봉인 체크포인트에서 복원 — 실행 중이던 프로세스는 종료되어 복원되지 않았고, 화면 기록만 다시 그렸습니다]",
  "restore.degraded":
    "터미널 복원 사이드카에 닿지 못해 복원이 제한됩니다(봉인 기록으로 폴백).",
  "restore.degraded-fresh": "복원 서비스 미가동 — 화면 기록 없이 새 셸로 시작합니다.",
  "restore.cold-blocked": "봉인 화면 복원이 차단되어 라이브만 시작합니다.",
  "sidecar.spawn-failed": "터미널 복원 사이드카 스폰에 실패했습니다.",
  "sidecar.subscribe-timeout":
    "복원 사이드카가 이 세션을 제때 구독하지 못했습니다 — 이 세션의 복원 충실도가 제한됩니다.",
};
const t = makeTranslator(EN, KO);

// 이 플러그인이 소비하는 **계약**. 그 계약을 어느 엔진 유닛이 구현하는지는 이 번들이 정하지 않는다 —
// 매니페스트 sidecars[] 가 정한다(SPEC: "The plugin manifest selects the unit"). 유닛명을 여기 상수로
// 굳히면 매니페스트만 바꿨을 때 옛 유닛이 무음으로 스폰된다(declared ≠ actual).
export const TERMINAL_CONTRACT = "soksak-spec-sidecar-terminal";

// 스폰은 항상 replay 를 명시한다 — undefined("코어 기본")는 없다. "none"=소비자 소유 또는
// 신선(코어 재생 없음), {fromSeq}=warm 핸드오프.
export type ReplayControl = "none" | { fromSeq: number };

export interface RestoreOutcome {
  replay: ReplayControl;
  // 소비자가 복원 화면을 그렸는가 — true 면 명령-블록 floor(이력 repaint)를 겹치지 않는다.
  // painted=false 면 코어 폴백에 기대지 않고, floor 가 이력 바닥을 깐다(복원 사다리 최후 단).
  painted: boolean;
}

// base64(ANSI 바이트) → Uint8Array. term.write 에 그대로 넘겨 raw 를 UTF-8 왜곡 없이 보존.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 생존 서비스 사이드카 스폰(idempotent — 싱글턴 프로브가 중복을 흡수). app.process 없으면 no-op.
// detached=setsid 생존(앱 종료를 넘어 산다). 실패는 삼키지 않고 활동 로그로 고지(무음 금지).
export function ensureSidecar(app: PluginApi): void {
  const proc = app.process;
  if (!proc) return;
  // 유닛 선택의 단일진실 = 매니페스트. 코어가 그 선언을 읽어 준다.
  const unit = proc.sidecarName(TERMINAL_CONTRACT);
  proc.spawn(`sidecar:${unit}`, [], { detached: true }).catch((e: unknown) => {
    app.activity.publish("terminal.sidecar.spawn-failed", {
      message: `${t("sidecar.spawn-failed", app.locale())} (${String(e)})`,
    });
  });
}

// 터미널 스폰 직후 호출 — 사이드카가 이 pane 의 세션을 구독하게 한다(부팅 후 태어난 세션의
// tee 를 근접-birth 에 잡아 다음 재시작의 warm 복원을 가능케 한다). 멱등.
//
// 사이드카 스폰(ensureSidecar)은 비동기라 첫 부팅엔 아직 서비스 소켓이 안 떠 있을 수 있다.
// 한 번만 시도하고 삼키면 구독이 안 서고, 이후 출력(사용자 명령)은 미러에 안 담겨 다음
// 재시작 warm 복원이 그 이력을 잃는다. 그래서 구독이 설 때까지 유계 재시도(백오프)한다 —
// 사이드카가 뜨는 즉시(대개 1~2s) 구독해, 사용자가 명령을 치기 전에 tee 를 잡는다. 유계
// 초과는 loud 고지(무음 아님) — 이번 부팅 복원 충실도가 제한됨을 알린다.
export async function ensureSession(
  app: PluginApi,
  paneId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const pty = app.pty;
  if (!pty) return;
  const deadline = Date.now() + 8000;
  let delay = 150;
  while (Date.now() < deadline) {
    try {
      const r = await pty.sidecarRequest({ op: "ensureSession", pane: paneId, cols, rows });
      if (r.ok === true) return; // 구독됨(또는 이미 미러 중).
      // ok:false(NOT_FOUND 등) — 세션이 아직 데몬 목록에 안 떴거나 사이드카 준비 중. 재시도.
    } catch {
      // 사이드카 미준비(relay connect 실패) — 재시도.
    }
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 2, 1000);
  }
  app.activity.publish("terminal.sidecar.subscribe-timeout", {
    message: `${t("sidecar.subscribe-timeout", app.locale())} (${paneId})`,
  });
}

// 사이드카 미러 격자를 pane 폭에 맞춘다(계약 resize op). tee 는 크기를 안 나르고 코어 resize 는
// 데몬 PTY 만 바꾸므로, 미러는 이 op 로만 폭을 안다 — 리사이즈마다(그리고 rehydrate 직전) 밀어
// 미러가 실 터미널과 어긋나지 않게 한다. 어긋나면 warm rehydrate 합성이 좁은 pane 에서 격자를
// 깬다(실측). best-effort: 미러 미구독(NOT_FOUND)·사이드카 미준비는 무해(다음 resize/ensureSession
// 이 따라잡는다). 같은 폭 반복은 no-op reflow = 멱등. 계약 op 라 4개 엔진 전부에 동일 적용.
export async function syncMirrorSize(
  app: PluginApi,
  paneId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const pty = app.pty;
  if (!pty || cols < 1 || rows < 1) return;
  try {
    await pty.sidecarRequest({ op: "resize", pane: paneId, cols, rows });
  } catch {
    /* 사이드카 미준비 — 다음 resize 가 따라잡는다(무음 무해) */
  }
}

// 마운트 시 화면 복원 결정 + inert 페인트(PTY 우회). spawn 전에 부른다: warm 은 uptoSeq 좌표가
// 필요하고, cold 는 신선 셸 출력이 겹치기 전에 먼저 그려야 한다.
export async function orchestrateRestore(
  app: PluginApi,
  paneId: string,
  writeInert: (data: string | Uint8Array) => void,
  opts?: { cols?: number; rows?: number },
): Promise<RestoreOutcome> {
  const pty = app.pty;
  if (!pty) return { replay: "none", painted: false };
  // [warm 재도색 폭 정합 — 미러를 pane 폭에 맞춘 뒤 재수화한다]
  // warm 화면은 사이드카 미러 그리드를 SGR 런으로 '합성'한 것(바이트 리플레이 아님). 미러는 tee(크기를
  // 안 나름)만 먹어 제 폭을 모르므로, 계약 resize op 로 밀어줘야 한다 — 코어 resize 는 데몬 PTY 만 바꾸고
  // 미러엔 전파하지 않는다. 안 밀면 미러가 pane 과 다른 폭에 머물러, 합성 paint(스크롤백은 개행 기반이라
  // 재감기지만 커서 CUP·행수는 미러 폭 좌표)가 좁은 pane 에서 어긋난다(실측 corruption: 분할 pane).
  // rehydrate 직전에 미러를 pane 현재 폭으로 resize(엔진 reflow)하면 합성이 그 폭에 정확해진다 → 분할
  // pane 도 단일 터미널과 똑같이 warm 재부착이 정확(TUI·정확 스크롤백 모두). 계약 op(resize/rehydrate)만
  // 쓰므로 4개 엔진(alacritty/wezterm/vt100/ghostty)에 멱등 적용 — 엔진 특례 없음. cold(봉인)는 cold_paint
  // 가 개행 기반(절대위치 없음)이라 폭-강건, resize 불요.
  const cols = opts?.cols;
  const rows = opts?.rows;

  // warm 후보 판정을 사이드카가 아니라 '데몬'에게 묻는다 — 데몬이 이 pane 의 라이브 세션 존재를
  // 즉답한다(사이드카 무관, 데몬 안 띄움). 세션이 없으면(신선 첫 open·죽은 세션·데몬 미가동)
  // 사이드카 rehydrate 를 아예 태우지 않는다: 부팅 직후 사이드카가 데몬에 붙는 중이면 rehydrate
  // 유계 재시도가 스폰을 지연시켜 신선 셸이 첫 명령 전에 안 뜬다(부팅 순서라는 우연이 신선 셸을
  // 늦추면 안 된다). 신선 세션의 사이드카 구독은 ensureSession(스폰 후)이 담당한다.
  let warmCandidate = false;
  try {
    warmCandidate = await pty.paneAlive(paneId);
  } catch {
    warmCandidate = false; // 데몬 미가동 등 — 그냥 스폰(코어 데몬-스폰 경로가 처리).
  }

  if (warmCandidate) {
    // rehydrate 전에 미러를 pane 현재 폭으로 맞춘다 — 폭-정합 재도색의 핵심(위 머리 주석). 미러
    // 미구독(NOT_FOUND)·사이드카 미준비는 무해(best-effort). pane 치수를 모르면(cols/rows 미제공)
    // 생략한다 — 옛 호출 호환.
    if (cols && rows) await syncMirrorSize(app, paneId, cols, rows);
    // 라이브 세션 존재 = warm 후보 → 사이드카 rehydrate 로 미러를 그린다. 부팅 직후엔 사이드카가
    // 데몬에 붙는 중일 수 있어 유계 백오프 재시도한다 — 이력 있는 warm 을 사이드카 늦음으로 잃지
    // 않게(부팅 핸드셰이크, 총 수 초 상한·폴링 아님·응답 or 데드라인에 종료). ensureSession 재시도와
    // 동형. 사이드카가 '응답'하면 즉시 반환: ok:true=warm, ok:false=미러 없음→봉인 폴백(재시도 아님).
    const deadline = Date.now() + 4000;
    let delay = 100;
    for (;;) {
      try {
        const reply = await pty.sidecarRequest({ op: "rehydrate", pane: paneId });
        if (reply.ok === true) {
          const data = reply.data as { paint: string; uptoSeq: number; altActive: boolean };
          // 미러를 pane 폭에 맞췄으니 합성 paint 는 이 폭에 정확하다 — 그대로 그린다(스크롤백·alt-screen
          // TUI 모두). 블록복원으로는 표현 못 하는 TUI 화면을 데몬 재접속이 정확히 되살린다. 소비자가
          // uptoSeq 까지 그렸으니 코어는 그 seq 부터 raw 링을 이어 붙인다(레이스-프리).
          writeInert(b64ToBytes(data.paint));
          return { replay: { fromSeq: data.uptoSeq }, painted: true };
        }
        break; // ok:false — 세션은 있는데 사이드카 미러 없음 → degraded 봉인 폴백.
      } catch {
        if (Date.now() >= deadline) break;
        await new Promise((res) => setTimeout(res, delay));
        delay = Math.min(delay * 2, 1000);
      }
    }
    // 재시도 소진 or ok:false — 라이브 세션인데 사이드카가 warm 미러를 못 줬다. degraded loud
    // 고지 + 리스폰, 봉인 폴백(사이드카 불요).
    app.activity.publish("terminal.restore.degraded", { message: t("restore.degraded", app.locale()) });
    ensureSidecar(app);
    return coldOrFresh(app, paneId, writeInert, true);
  }

  // 라이브 세션 없음 → cold(봉인 블롭) 또는 fresh. 사이드카를 안 기다린다(신선 셸 즉시 스폰).
  return coldOrFresh(app, paneId, writeInert, false);
}

async function coldOrFresh(
  app: PluginApi,
  paneId: string,
  writeInert: (data: string | Uint8Array) => void,
  sidecarDown: boolean,
): Promise<RestoreOutcome> {
  const pty = app.pty;
  if (!pty) return { replay: "none", painted: false };
  try {
    const sealed = await pty.readSealedScreen(paneId);
    if (sealed) {
      // 봉인 페인트(cold_paint)는 개행 기반(절대위치 없음)이라 어느 폭에서든 재감긴다 — 죽은 세션은
      // 미러가 없어 resize 할 수 없지만, 폭-강건 직렬화라 좁은 pane 에서도 격자가 안 깨진다.
      writeInert(b64ToBytes(sealed.paintB64));
      // 소실 고지 — 실행 중이던 프로세스는 종료되어 복원되지 않았음을 화면에 찍는다(무음 금지).
      writeInert(`\x1b[2m${t("cold-restore-notice", app.locale())}\x1b[0m\r\n`);
      return { replay: "none", painted: true };
    }
  } catch (e) {
    // 잠금(fail-closed) 등으로 cold 차단 — floor 로 떨어진다(라이브만 시작).
    app.activity.publish("terminal.restore.cold-blocked", {
      message: `${t("restore.cold-blocked", app.locale())} (${String(e)})`,
    });
  }
  // 봉인 블롭 없음(또는 cold 차단):
  if (sidecarDown) {
    // 사이드카 다운 + 봉인 기록 없음 — 복원할 화면이 없다. 코어 폴백은 없다: 무음 대신
    // degraded 를 화면·활동에 loud 고지하고 신선 셸로 간다. 명령-블록
    // floor 가 이력 바닥을 깐다(복원 사다리 최후 단).
    writeInert(`\x1b[2m${t("restore.degraded-fresh", app.locale())}\x1b[0m\r\n`);
    app.activity.publish("terminal.restore.degraded-fresh", {
      message: t("restore.degraded-fresh", app.locale()),
    });
    return { replay: "none", painted: false };
  }
  // 신선 터미널 — 복원할 것 없음(신선 스폰이 프롬프트를 보이고 floor 가 이력을 그린다).
  return { replay: "none", painted: false };
}
