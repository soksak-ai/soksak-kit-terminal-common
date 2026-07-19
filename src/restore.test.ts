import { describe, it, expect, vi } from "vitest";
import { orchestrateRestore, ensureSidecar, ensureSession } from "./restore";
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
        if (req.op === "rehydrate") {
          if (!stubs.rehydrate) return { ok: false, code: "NOT_FOUND" };
          return stubs.rehydrate();
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
  return { app, published, spawned };
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
