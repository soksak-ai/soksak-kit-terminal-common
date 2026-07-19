// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { mountTerminalView } from "./mount-terminal-view";
import { createTerminalRegistry } from "./terminal-registry";
import { createFocusCoordinator } from "./focus-coordinator";
import type { TerminalRenderer } from "./terminal-renderer";

function fakeRenderer(id: string): TerminalRenderer {
  const element = document.createElement("div");
  element.dataset.pane = id;
  return {
    element,
    restorePainted: false,
    focus: vi.fn(),
    prepareFocusTransfer: vi.fn(),
    fit: vi.fn(),
    sendInput: vi.fn(),
    readBuffer: () => id, // pane 을 tag 로 식별(readBuffer 가 자기 id 반환)
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

function fakeApp() {
  // 코어 IO substrate 모사 — key(viewId 또는 paneId)로 핸들을 담는다. term.read/term.send 가 key 로 해소.
  const ios = new Map<string, { readBuffer: (n?: number) => string; sendInput: (d: string) => void }>();
  const app = {
    pty: {
      registerIo: (
        key: string,
        handlers: { readBuffer: (n?: number) => string; sendInput: (d: string) => void },
      ) => {
        ios.set(key, handlers);
        return { dispose: () => void ios.delete(key) };
      },
    },
  } as unknown as import("./host-contract").PluginApi;
  return { app, ios };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mountTerminalView", () => {
  it("single mode: one renderer mounted, IO/focus/registry wired to it", async () => {
    const { app, ios } = fakeApp();
    const mountRoot = document.createElement("div");
    const registry = createTerminalRegistry();
    const focus = createFocusCoordinator();
    const created: string[] = [];
    const handle = mountTerminalView(app, {
      mountRoot,
      viewId: "v1",
      withinTab: false,
      focus,
      registry,
      createRenderer: async (paneId) => {
        created.push(paneId);
        return fakeRenderer(paneId);
      },
      setStatus: vi.fn(),
      emptyMessage: "empty",
    });
    await flush();

    expect(created).toEqual(["v1"]); // 단일 = viewId 로 한 번
    expect(mountRoot.querySelector('[data-pane="v1"]')).toBeTruthy();
    expect(handle.splitHost).toBeNull();
    expect(registry.get("v1")?.readBuffer()).toBe("v1");
    expect(ios.get("v1")?.readBuffer()).toBe("v1");

    handle.dispose();
    expect(registry.get("v1")).toBeUndefined();
    expect(ios.size).toBe(0);
  });

  it("within-tab: proxy + IO follow the active pane across a split", async () => {
    const { app, ios } = fakeApp();
    const mountRoot = document.createElement("div");
    const registry = createTerminalRegistry();
    const focus = createFocusCoordinator();
    const created: string[] = [];
    const handle = mountTerminalView(app, {
      mountRoot,
      viewId: "v1",
      withinTab: true,
      focus,
      registry,
      createRenderer: async (paneId) => {
        created.push(paneId);
        return fakeRenderer(paneId);
      },
      setStatus: vi.fn(),
      emptyMessage: "empty",
    });
    await flush();

    expect(created).toEqual(["v1~0"]); // 첫 pane
    expect(handle.splitHost).not.toBeNull();
    // 뷰 하나가 registry 에 프록시로 등록 — 활성 pane(v1~0)에 위임.
    expect(registry.get("v1")?.readBuffer()).toBe("v1~0");
    // 뷰 IO(viewId) = 활성 pane 위임.
    expect(ios.get("v1")?.readBuffer()).toBe("v1~0");
    // pane 개별 주소(paneId) = 그 pane 직접(활성 무관).
    expect(ios.get("v1~0")?.readBuffer()).toBe("v1~0");

    // 분할 → 새 pane 활성. 뷰 IO/프록시는 재등록 없이 활성(v1~1)을 따라가고, 각 pane 은 자기 id 로 유지.
    await handle.splitHost!.split("row");
    await flush();
    expect(created).toEqual(["v1~0", "v1~1"]);
    expect(registry.get("v1")?.readBuffer()).toBe("v1~1"); // 프록시 = 활성
    expect(ios.get("v1")?.readBuffer()).toBe("v1~1"); // 뷰 IO = 활성
    expect(ios.get("v1~0")?.readBuffer()).toBe("v1~0"); // pane 0 은 여전히 자기 것
    expect(ios.get("v1~1")?.readBuffer()).toBe("v1~1"); // pane 1 개별 주소

    handle.dispose();
    await flush(); // splitHost.dispose() 는 async — pane 렌더러 dispose(=pane IO 해지) 완료 대기
    expect(registry.get("v1")).toBeUndefined();
    expect(ios.size).toBe(0); // 뷰 IO + 모든 pane IO 해지
  });

  it("disposing before the async renderer resolves still tears the renderer down", async () => {
    const { app } = fakeApp();
    const mountRoot = document.createElement("div");
    const registry = createTerminalRegistry();
    const focus = createFocusCoordinator();
    const r = fakeRenderer("v1");
    const handle = mountTerminalView(app, {
      mountRoot,
      viewId: "v1",
      withinTab: false,
      focus,
      registry,
      createRenderer: async () => r,
      setStatus: vi.fn(),
      emptyMessage: "empty",
    });
    handle.dispose(); // 렌더러 resolve 전 unmount
    await flush();
    expect(r.dispose).toHaveBeenCalled();
    expect(registry.get("v1")).toBeUndefined();
  });
});
