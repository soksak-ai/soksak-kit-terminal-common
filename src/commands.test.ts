import { describe, it, expect, vi } from "vitest";
import { registerTerminalCommands, registerSplitPaneCommand } from "./commands";
import { createTerminalRegistry } from "./terminal-registry";
import type { TerminalRenderer } from "./terminal-renderer";
import type { PaneSplitHost } from "./pane-split";

// 최소 렌더러 — 명령 핸들러는 element 를 만지지 않으므로 캐스트로 둔다(DOM 불요).
function fakeRenderer(tag: string) {
  const sent: string[] = [];
  let cleared = 0;
  const renderer: TerminalRenderer = {
    element: {} as unknown as HTMLElement,
    restorePainted: false,
    focus: () => {},
    prepareFocusTransfer: () => {},
    fit: () => {},
    sendInput: (d) => void sent.push(d),
    readBuffer: () => tag,
    write: () => {},
    clear: () => void (cleared += 1),
    dispose: async () => {},
  };
  return { renderer, sent, cleared: () => cleared };
}

// app.commands.register 를 가로채 이름→spec 을 모은다.
function fakeCtx() {
  const registered = new Map<string, { handler: (p: Record<string, unknown>) => unknown }>();
  const ctx = {
    subscriptions: [] as Array<{ dispose(): void }>,
    app: {
      commands: {
        register: (name: string, spec: { handler: (p: Record<string, unknown>) => unknown }) => {
          registered.set(name, spec);
          return { dispose() {} };
        },
      },
    },
  } as unknown as import("./host-contract").PluginContext;
  return { ctx, registered };
}

describe("registerTerminalCommands — view addressing rule", () => {
  it("send/clear/resume resolve the target by view, else first active", () => {
    const registry = createTerminalRegistry();
    const a = fakeRenderer("A");
    const b = fakeRenderer("B");
    registry.set("vA", a.renderer); // 첫 등록 = 기본 대상
    registry.set("vB", b.renderer);
    const { ctx, registered } = fakeCtx();
    registerTerminalCommands(ctx, registry);

    // send 는 지정 view 로 — vB 에 닿고 vA 는 안 건드린다.
    expect(registered.get("send")!.handler({ text: "hi", view: "vB" })).toMatchObject({
      ok: true,
      viewId: "vB",
    });
    expect(b.sent).toContain("hi");
    expect(a.sent).toHaveLength(0);

    // view 없으면 첫 활성(vA).
    registered.get("send")!.handler({ text: "yo" });
    expect(a.sent).toContain("yo");

    // clear 도 지정 view.
    registered.get("clear")!.handler({ view: "vB" });
    expect(b.cleared()).toBe(1);

    // resume 은 UUID + 지정 view.
    const uuid = "12345678-1234-1234-1234-123456789abc";
    expect(registered.get("resume")!.handler({ session: uuid, view: "vB" })).toMatchObject({
      ok: true,
      viewId: "vB",
    });
    expect(b.sent.some((s) => s.includes(uuid))).toBe(true);
  });

  it("resume rejects a non-UUID sessionId (injection gate)", () => {
    const registry = createTerminalRegistry();
    const a = fakeRenderer("A");
    registry.set("vA", a.renderer);
    const { ctx, registered } = fakeCtx();
    registerTerminalCommands(ctx, registry);
    expect(registered.get("resume")!.handler({ session: "bad; rm -rf /" })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(a.sent).toHaveLength(0);
  });

  it("returns NO_TARGET when the registry is empty", () => {
    const { ctx, registered } = fakeCtx();
    registerTerminalCommands(ctx, createTerminalRegistry());
    expect(registered.get("send")!.handler({ text: "x" })).toMatchObject({
      ok: false,
      code: "NO_TARGET",
    });
  });
});

describe("registerSplitPaneCommand", () => {
  it("resolves the host, maps dir → row/col, returns the new paneId", async () => {
    const split = vi.fn(async (dir: "row" | "col") => `p-${dir}`);
    const host = { split } as unknown as PaneSplitHost;
    const { ctx, registered } = fakeCtx();
    registerSplitPaneCommand(ctx, (view) => (view === "vX" || !view ? { viewId: "vX", host } : null));

    // dir 기본 = right → row
    expect(await registered.get("split-pane")!.handler({ view: "vX" })).toMatchObject({
      ok: true,
      viewId: "vX",
      paneId: "p-row",
    });
    expect(split).toHaveBeenLastCalledWith("row");
    // down → col
    await registered.get("split-pane")!.handler({ view: "vX", dir: "down" });
    expect(split).toHaveBeenLastCalledWith("col");
  });

  it("returns NO_TARGET when no within-tab host resolves", async () => {
    const { ctx, registered } = fakeCtx();
    registerSplitPaneCommand(ctx, () => null);
    expect(await registered.get("split-pane")!.handler({ view: "nope" })).toMatchObject({
      ok: false,
      code: "NO_TARGET",
    });
  });
});
