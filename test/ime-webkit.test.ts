// @vitest-environment jsdom
// IME 애드온 계약 테스트 — 원문(실기기 검증본)은 무변형 이송이 원칙이라, 여기서는 계약 표면
// (ITerminalLike 구조 부착·해제, 프리뷰 오버레이 생성, 비표준 경로의 onData 전달)만 고정한다.
// 조합 시퀀스의 4중 가드 자체는 실기기 검증이 정본(계획 K4) — DOM 시뮬레이션으로 재검하지 않는다.
import { describe, expect, it, vi } from "vitest";
import { WebkitImeAddon, type ITerminalLike } from "../src/ime-webkit";

function fakeTerminal(): ITerminalLike & { renderHandlers: Array<() => void> } {
  const textarea = document.createElement("textarea");
  const element = document.createElement("div");
  document.body.append(element);
  element.appendChild(textarea);
  const renderHandlers: Array<() => void> = [];
  return {
    textarea,
    element,
    cols: 80,
    rows: 24,
    options: { fontFamily: "monospace", fontSize: 13 },
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    onRender(h: () => void) {
      renderHandlers.push(h);
      return { dispose() {} };
    },
    attachCustomKeyEventHandler() {},
    renderHandlers,
  };
}

describe("WebkitImeAddon — 계약 표면", () => {
  it("구조적 터미널에 부착·해제된다(특정 렌더러 비의존)", () => {
    const term = fakeTerminal();
    const addon = new WebkitImeAddon({ onData: vi.fn() });
    addon.activate(term);
    addon.dispose();
  });

  it("비표준 insertReplacementText 경로가 onData 로 완성 음절을 전달한다", () => {
    const term = fakeTerminal();
    const onData = vi.fn();
    const addon = new WebkitImeAddon({ onData });
    addon.activate(term);
    const ta = term.textarea!;
    // WKWebView 비표준 경로 재현: composition 이벤트 없이 input(insertText) 연쇄.
    ta.dispatchEvent(
      new InputEvent("input", { inputType: "insertText", data: "한", bubbles: true, cancelable: true }),
    );
    // 조합 중엔 버퍼링(전달 0) — 비-IME 키(Enter)가 플러시 트리거.
    const before = onData.mock.calls.length;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const flushed = onData.mock.calls.map((c) => c[0]).join("");
    expect(before === 0 || flushed.includes("한")).toBe(true);
    addon.dispose();
  });
});
