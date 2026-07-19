// 터미널 활동 자기기술 — command.started/finished 를 활동 엔트리(표시 message / 낭독 speak)로
// 구성하는 순수부. 렌더러가 소유하던 낭독 문장(코어 아님, MESSAGE-PROTOCOL §3)을 못박는다.
import { describe, expect, it } from "vitest";
import { terminalStartedActivity, terminalFinishedActivity } from "./activity";

describe("terminalStartedActivity — 표시만(무낭독)", () => {
  it("명령라인을 $ 프롬프트 표시로", () => {
    expect(terminalStartedActivity("echo hi")).toEqual({ message: "$ echo hi" });
  });
  it("명령라인 없음 = $ 만(trim)", () => {
    expect(terminalStartedActivity(null)).toEqual({ message: "$" });
  });
});

describe("terminalFinishedActivity — 표시 message + 낭독 speak", () => {
  it("성공(exit 0, ko): 종료 표시 + 끝났어요 낭독", () => {
    expect(terminalFinishedActivity(0, "ko")).toEqual({
      message: "종료 0",
      speak: "터미널 명령이 끝났어요.",
    });
  });
  it("실패(exit 2, ko): 종료 2 표시 + 코드 낭독", () => {
    expect(terminalFinishedActivity(2, "ko")).toEqual({
      message: "종료 2",
      speak: "명령이 실패했어요. 코드 2.",
    });
  });
  it("성공(exit 0, en): 영어 i18n", () => {
    expect(terminalFinishedActivity(0, "en")).toEqual({
      message: "exit 0",
      speak: "A terminal command finished.",
    });
  });
  it("코드 없음 = 성공 취급(무코드 표시)", () => {
    expect(terminalFinishedActivity(undefined, "ko")).toEqual({
      message: "종료",
      speak: "터미널 명령이 끝났어요.",
    });
  });
});
