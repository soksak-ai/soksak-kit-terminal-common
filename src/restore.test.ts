import { describe, it, expect, vi } from "vitest";
import { orchestrateRestore, ensureSidecar, ensureSession, syncMirrorSize } from "./restore";
import type { PluginApi } from "./host-contract";

// base64 of a tiny ANSI marker so the paint carries something recognizable.
const paintB64 = (s: string) => btoa(s);

interface Stubs {
  rehydrate?: () => unknown; // throw = sidecar down; return reply envelope
  sealed?: unknown | null | (() => never);
  paneAlive?: boolean; // 데몬에 라이브 세션 존재(warm 후보). 기본 false = 신선/cold.
}

function fakeApp(stubs: Stubs) {
  const published: Array<{ kind: string; message: string }> = [];
  const spawned: string[] = [];
  // 모든 sidecarRequest op 를 순서대로 기록 — resize 가 rehydrate 보다 먼저 왔는지(폭-정합) 단언용.
  const ops: Array<Record<string, unknown>> = [];
  const app = {
    locale: () => "ko",
    activity: {
      publish: (kind: string, entry: { message: string }) =>
        published.push({ kind, message: entry.message }),
    },
    process: {
      // 코어가 매니페스트 sidecars[] 에서 읽어 주는 유닛명(이 플러그인의 선언 = terminal-alacritty).
      sidecarName: () => "terminal-alacritty",
      spawn: async (cmd: string) => {
        spawned.push(cmd);
        return 1;
      },
    },
    pty: {
      sidecarRequest: async (req: Record<string, unknown>) => {
        ops.push(req);
        if (req.op === "rehydrate") {
          if (!stubs.rehydrate) return { ok: false, code: "NOT_FOUND" };
          return stubs.rehydrate();
        }
        if (req.op === "resize") {
          // 미러 폭 맞춤(계약 op) — 미러 있으면 격자 reflow, 없으면 NOT_FOUND(무해).
          return { ok: true, code: "OK", data: { cols: req.cols, rows: req.rows } };
        }
        return { ok: true, code: "OK", data: {} };
      },
      readSealedScreen: async () => {
        if (typeof stubs.sealed === "function") return (stubs.sealed as () => never)();
        return (stubs.sealed ?? null) as { paintB64: string; altActive: boolean } | null;
      },
      paneAlive: async () => stubs.paneAlive ?? false,
    },
  } as unknown as PluginApi;
  return { app, published, spawned, ops };
}

// rehydrate 재시도 유계를 즉시 소진시킨다 — Date.now 를 크게 전진시켜 부팅 핸드셰이크 데드라인을
// 곧장 넘긴다(실 setTimeout 은 유지 → 짧은 실지연 1~2회). ensureSession 테스트와 같은 기법.
function exhaustRetry(): () => void {
  const realNow = Date.now;
  let t = realNow();
  vi.spyOn(Date, "now").mockImplementation(() => (t += 2500));
  return () => {
    Date.now = realNow;
  };
}

describe("orchestrateRestore", () => {
  it("warm: rehydrate paints inert and attaches from uptoSeq", async () => {
    const { app } = fakeApp({
      paneAlive: true, // 데몬에 라이브 세션 = warm 후보 → rehydrate 를 탄다
      rehydrate: () => ({
        ok: true,
        code: "OK",
        data: { paint: paintB64("WARM-SCREEN"), uptoSeq: 4096, altActive: false },
      }),
    });
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1", (d) => writes.push(bytesToStr(d)));
    expect(out.painted).toBe(true);
    expect(out.replay).toEqual({ fromSeq: 4096 });
    expect(writes.join("")).toContain("WARM-SCREEN");
  });

  // [폭 정합 — warm 재도색 전 미러를 pane 폭으로 맞춘다]
  // warm 화면은 미러 그리드를 SGR 런으로 합성한 것이다. 미러는 tee(크기 미포함)만 먹어 제 폭을
  // 모르므로(코어 resize 는 데몬 PTY 만 바꿈), pane 이 좁은데 미러가 넓으면 합성 paint 가 격자를
  // 깬다(실측: 분할 pane). rehydrate 직전에 계약 resize op 로 미러를 pane 폭으로 맞추면(엔진 reflow)
  // 합성이 그 폭에 정확 — 분할 pane 도 단일 터미널과 똑같이 warm 재부착이 정확하다(특례 없음).
  it("warm + pane 치수: rehydrate 전에 미러를 그 폭으로 resize 한 뒤 그린다 (폭-정합 재도색)", async () => {
    const { app, ops } = fakeApp({
      paneAlive: true,
      rehydrate: () => ({
        ok: true,
        code: "OK",
        data: { paint: paintB64("WARM-SCREEN"), uptoSeq: 4096, altActive: false },
      }),
    });
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1~1", (d) => writes.push(bytesToStr(d)), {
      cols: 40,
      rows: 12,
    });
    const resizeIdx = ops.findIndex((o) => o.op === "resize");
    const rehydrateIdx = ops.findIndex((o) => o.op === "rehydrate");
    expect(resizeIdx).toBeGreaterThanOrEqual(0); // 미러 폭을 맞춘다
    expect(ops[resizeIdx]).toMatchObject({ op: "resize", pane: "v1~1", cols: 40, rows: 12 });
    expect(resizeIdx).toBeLessThan(rehydrateIdx); // 재도색(rehydrate) 전에 폭을 맞춘다 — 순서가 결정적
    expect(out).toEqual({ replay: { fromSeq: 4096 }, painted: true }); // 미러를 그리고 라이브 이음
    expect(writes.join("")).toContain("WARM-SCREEN");
  });

  it("warm + alt-screen TUI(claude/LLM): 데몬 재접속이 미러를 그려 복원 — 블록복원으로 표현 못 하는 화면", async () => {
    const { app, ops } = fakeApp({
      paneAlive: true,
      rehydrate: () => ({
        ok: true,
        code: "OK",
        data: { paint: paintB64("CLAUDE-TUI"), uptoSeq: 99, altActive: true },
      }),
    });
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1~1", (d) => writes.push(bytesToStr(d)), {
      cols: 40,
      rows: 12,
    });
    // TUI 도 pane 폭으로 미러를 맞춘 뒤 그린다 — 데몬 재접속만이 살아있는 TUI 를 복원한다.
    expect(ops.some((o) => o.op === "resize" && o.cols === 40 && o.rows === 12)).toBe(true);
    expect(out).toEqual({ replay: { fromSeq: 99 }, painted: true });
    expect(writes.join("")).toContain("CLAUDE-TUI");
  });

  it("warm + pane 치수 미제공(옛 호출): resize 를 보내지 않는다 (back-compat)", async () => {
    const { app, ops } = fakeApp({
      paneAlive: true,
      rehydrate: () => ({
        ok: true,
        code: "OK",
        data: { paint: paintB64("WARM"), uptoSeq: 1, altActive: false },
      }),
    });
    await orchestrateRestore(app, "v1", () => {}); // opts 없음
    expect(ops.some((o) => o.op === "resize")).toBe(false); // 치수 모르면 미러 폭 미조작
  });

  it("cold(죽은 세션): 미러 없음 → resize 안 함, 봉인 페인트(cold_paint 개행 기반)라 폭-강건", async () => {
    const { app, ops } = fakeApp({ sealed: { paintB64: paintB64("COLD-SCREEN"), altActive: false } });
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1~1", (d) => writes.push(bytesToStr(d)), {
      cols: 40,
      rows: 12,
    });
    expect(ops.some((o) => o.op === "resize")).toBe(false); // 죽은 세션은 미러가 없어 resize 불가·불요
    expect(out.painted).toBe(true);
    expect(writes.join("")).toContain("COLD-SCREEN");
  });

  it("cold: no live mirror but a sealed blob → paint + loss notice, replay none", async () => {
    const { app } = fakeApp({
      // rehydrate undefined → NOT_FOUND
      sealed: { paintB64: paintB64("COLD-SCREEN"), altActive: false },
    });
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1", (d) => writes.push(bytesToStr(d)));
    expect(out.replay).toBe("none");
    expect(out.painted).toBe(true);
    const all = writes.join("");
    expect(all).toContain("COLD-SCREEN");
    expect(all).toContain("복원"); // 소실 고지가 화면에 찍힌다(무음 금지)
  });

  it("fresh: no mirror and no blob → replay none, floor draws", async () => {
    const { app } = fakeApp({ sealed: null }); // paneAlive 기본 false = 신선
    const out = await orchestrateRestore(app, "v1", () => {});
    expect(out.replay).toBe("none"); // 스폰은 항상 명시(코어 폴백 없음)
    expect(out.painted).toBe(false); // floor 가 이력 바닥을 깐다
  });

  it("fresh (no live daemon session): never waits on the sidecar rehydrate", async () => {
    // ① 핵심 회귀 방지 — 신선 첫 open 은 데몬에 세션이 없으니(paneAlive=false) 사이드카가 떠 있든
    // 아니든 rehydrate 를 아예 안 부른다. 부팅 직후 사이드카가 데몬에 붙는 중이어도 스폰이 안 밀린다.
    let rehydrateCalls = 0;
    const { app } = fakeApp({
      paneAlive: false,
      rehydrate: () => {
        rehydrateCalls++;
        throw new Error("sidecar still connecting"); // 있어도 안 물어봐야 한다
      },
    });
    const out = await orchestrateRestore(app, "v1", () => {});
    expect(rehydrateCalls).toBe(0); // 사이드카 대기 0 — 즉시 스폰
    expect(out.replay).toBe("none");
    expect(out.painted).toBe(false);
  });

  it("warm boot-race: retries rehydrate until the sidecar comes up, then attaches", async () => {
    // ②③ 데몬에 라이브 세션 존재(warm 후보) + 사이드카가 늦음 — 부팅 직후 사이드카 소켓이 아직
    // 없어 connect 가 거부되다가(2회) 뜨면(3회) 성공. 즉시 degraded 로 안 떨어지고 유계 재시도로
    // warm 에 수렴해야 한다(이력 복원 유실 방지).
    let calls = 0;
    const { app } = fakeApp({
      paneAlive: true, // warm 후보 → 재시도가 가치 있다
      rehydrate: () => {
        calls++;
        if (calls < 3) throw new Error("no terminal sidecar"); // 스폰 중 — 소켓 미도달
        return { ok: true, code: "OK", data: { paint: paintB64("WARM-LATE"), uptoSeq: 77, altActive: false } };
      },
    });
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1", (d) => writes.push(bytesToStr(d)));
    expect(calls).toBe(3); // 두 번 실패 후 세 번째에 성공(즉시 포기 아님)
    expect(out.replay).toEqual({ fromSeq: 77 });
    expect(out.painted).toBe(true);
    expect(writes.join("")).toContain("WARM-LATE");
  });

  it("degraded: a dead sidecar is retried to the bound, then announced and falls to the seal path", async () => {
    let calls = 0;
    const { app, published, spawned } = fakeApp({
      paneAlive: true, // 라이브 세션인데 사이드카가 미러를 못 준다 → 재시도 후 봉인 폴백
      rehydrate: () => {
        calls++;
        throw new Error("no terminal sidecar");
      },
      sealed: { paintB64: paintB64("COLD-VIA-FALLBACK"), altActive: false },
    });
    const restore = exhaustRetry();
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1", (d) => writes.push(bytesToStr(d)));
    restore();
    expect(calls).toBeGreaterThan(1); // 즉시 포기 아님 — 유계 재시도 후 소진
    expect(published.some((p) => p.kind === "terminal.restore.degraded")).toBe(true);
    expect(spawned).toContain("sidecar:terminal-alacritty"); // 리스폰
    expect(out.painted).toBe(true);
    expect(out.replay).toBe("none");
    expect(writes.join("")).toContain("COLD-VIA-FALLBACK");
  });

  it("degraded with no blob → retried to the bound, then loud degraded-fresh notice", async () => {
    let calls = 0;
    const { app, published } = fakeApp({
      paneAlive: true, // 라이브 세션인데 사이드카 미러 없음 + 봉인도 없음 → 재시도 후 degraded-fresh
      rehydrate: () => {
        calls++;
        throw new Error("down");
      },
      sealed: null,
    });
    const restore = exhaustRetry();
    const writes: string[] = [];
    const out = await orchestrateRestore(app, "v1", (d) => writes.push(bytesToStr(d)));
    restore();
    expect(calls).toBeGreaterThan(1); // 유계 재시도 후 소진(즉시 degraded 아님)
    // 코어 폴백 없이 신선 셸 — 무음 금지: 화면 + 활동에 고지.
    expect(out.replay).toBe("none");
    expect(out.painted).toBe(false); // floor 가 이력 바닥을 깐다
    expect(published.some((p) => p.kind === "terminal.restore.degraded-fresh")).toBe(true);
    expect(writes.join("")).toContain("복원 서비스 미가동"); // 화면에도 loud
  });
});

describe("syncMirrorSize", () => {
  // 계약 resize op 로 미러 격자를 pane 폭에 맞춘다 — 4개 엔진 공통(op 만 씀). 리사이즈마다·rehydrate
  // 직전에 불려 미러가 실 터미널과 어긋나지 않게 한다. 같은 폭 반복은 no-op reflow = 멱등.
  it("계약 resize op 로 미러를 pane 폭에 맞춘다", async () => {
    const { app, ops } = fakeApp({});
    await syncMirrorSize(app, "v1~1", 40, 12);
    expect(ops).toContainEqual({ op: "resize", pane: "v1~1", cols: 40, rows: 12 });
  });

  it("0/음수 치수는 보내지 않는다(계약 resize 는 양수만)", async () => {
    const { app, ops } = fakeApp({});
    await syncMirrorSize(app, "v1", 0, 12);
    await syncMirrorSize(app, "v1", 40, 0);
    expect(ops.some((o) => o.op === "resize")).toBe(false);
  });

  it("사이드카 미준비(throw)는 삼킨다 — best-effort(다음 resize 가 따라잡는다)", async () => {
    const app = {
      locale: () => "ko",
      activity: { publish: () => {} },
      pty: {
        sidecarRequest: async () => {
          throw new Error("no terminal sidecar");
        },
      },
    } as unknown as PluginApi;
    await expect(syncMirrorSize(app, "v1", 40, 12)).resolves.toBeUndefined();
  });
});

describe("ensureSession", () => {
  it("retries until the sidecar subscribes (survives an async sidecar spawn)", async () => {
    let calls = 0;
    const app = {
      locale: () => "ko",
      activity: { publish: () => {} },
      pty: {
        sidecarRequest: async (req: Record<string, unknown>) => {
          expect(req.op).toBe("ensureSession");
          calls++;
          if (calls < 3) throw new Error("no terminal sidecar"); // 아직 안 뜸
          return { ok: true, code: "OK", data: { subscribed: true } };
        },
      },
    } as unknown as PluginApi;
    await ensureSession(app, "v1", 80, 24);
    expect(calls).toBe(3); // 두 번 실패 후 세 번째에 구독 성공
  });

  it("gives up loudly after the bound instead of silently", async () => {
    const published: string[] = [];
    const app = {
      locale: () => "ko",
      activity: { publish: (kind: string) => published.push(kind) },
      pty: {
        sidecarRequest: async () => {
          throw new Error("down");
        },
      },
    } as unknown as PluginApi;
    // deadline 을 짧게: Date.now 를 진행시켜 유계 초과를 강제한다.
    const realNow = Date.now;
    let t = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => (t += 3000)); // 매 호출마다 3s 전진
    await ensureSession(app, "v1", 80, 24);
    Date.now = realNow;
    expect(published).toContain("terminal.sidecar.subscribe-timeout");
  });
});

describe("ensureSidecar", () => {
  it("spawns the survival sidecar detached", async () => {
    const spawn = vi.fn(async () => 1);
    const app = {
      locale: () => "ko",
      activity: { publish: () => {} },
      process: { spawn, sidecarName: () => "terminal-alacritty" },
    } as unknown as PluginApi;
    ensureSidecar(app);
    expect(spawn).toHaveBeenCalledWith("sidecar:terminal-alacritty", [], { detached: true });
  });
});

describe("유닛 선택의 단일진실 = 매니페스트", () => {
  // 계약: 어느 엔진 유닛을 스폰할지는 **매니페스트 sidecars[] 가 정한다**(SPEC: "The plugin manifest
  // selects the unit"). 번들에 유닛명을 상수로 굳히면 매니페스트만 바꿨을 때 무음으로 옛 엔진이
  // 스폰된다 — declared ≠ actual 이고, 그 어긋남은 아무 데서도 안 잡힌다.
  it("매니페스트가 선언한 유닛을 스폰한다(상수가 아니라)", async () => {
    const spawn = vi.fn(async () => 1);
    const app = {
      locale: () => "ko",
      activity: { publish: () => {} },
      // 코어가 이 플러그인의 매니페스트에서 계약을 구현한다고 선언된 유닛을 알려 준다.
      process: { spawn, sidecarName: () => "terminal-wezterm" },
    } as unknown as PluginApi;
    ensureSidecar(app);
    expect(spawn).toHaveBeenCalledWith("sidecar:terminal-wezterm", [], { detached: true });
  });
});

function bytesToStr(d: string | Uint8Array): string {
  return typeof d === "string" ? d : new TextDecoder().decode(d);
}
