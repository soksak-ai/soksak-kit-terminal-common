import { describe, it, expect, vi } from "vitest";
import { createFocusCoordinator, type FocusTarget } from "./focus-coordinator";

function fakeRenderer() {
  const focus = vi.fn();
  const prepareFocusTransfer = vi.fn();
  const renderer: FocusTarget = { focus, prepareFocusTransfer };
  return { renderer, focus, prepareFocusTransfer };
}

const live = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

describe("createFocusCoordinator", () => {
  it("focuses immediately when the renderer is already attached", () => {
    const c = createFocusCoordinator();
    const { renderer, focus } = fakeRenderer();
    c.attach(renderer);
    c.request(live());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("holds the request until the renderer attaches, then applies it", () => {
    const c = createFocusCoordinator();
    const { renderer, focus } = fakeRenderer();
    c.request(live()); // 렌더러 없음 — pending
    expect(focus).not.toHaveBeenCalled();
    c.attach(renderer); // 붙는 즉시 적용
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("focuses on activation even when DOM focus already sits in the container (the bug fix)", () => {
    // 창전환 회귀 방지: 코어가 DOM 포커스를 container 로 옮긴 뒤 focus() 를 부른다 —
    // 코디네이터는 activeElement 를 검사하지 않으므로 렌더러를 실제로 포커스한다.
    const c = createFocusCoordinator();
    const { renderer, focus } = fakeRenderer();
    c.attach(renderer);
    c.request(live()); // container 가 DOM 포커스를 가졌든 말든 렌더러를 포커스한다
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("skips an aborted request (focus moved to another view)", () => {
    const c = createFocusCoordinator();
    const { renderer, focus } = fakeRenderer();
    c.attach(renderer);
    const ac = new AbortController();
    ac.abort();
    c.request({ signal: ac.signal });
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not re-fire a consumed request on a second attach", () => {
    const c = createFocusCoordinator();
    const a = fakeRenderer();
    c.request(live());
    c.attach(a.renderer);
    expect(a.focus).toHaveBeenCalledTimes(1);
    const b = fakeRenderer();
    c.attach(b.renderer); // pending 은 이미 소비됨 — 재발화 없음
    expect(b.focus).not.toHaveBeenCalled();
  });

  it("delegates prepareTransfer to the renderer's IME commit", () => {
    const c = createFocusCoordinator();
    const { renderer, prepareFocusTransfer } = fakeRenderer();
    c.attach(renderer);
    c.prepareTransfer();
    expect(prepareFocusTransfer).toHaveBeenCalledTimes(1);
  });

  it("detach clears the renderer and any pending request", () => {
    const c = createFocusCoordinator();
    const { renderer, focus } = fakeRenderer();
    c.request(live());
    c.detach(); // pending 폐기
    c.attach(renderer);
    expect(focus).not.toHaveBeenCalled();
  });
});
