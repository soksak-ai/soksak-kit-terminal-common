// 터미널 활동 자기기술 — command.started/finished 를 활동 엔트리(표시 message / 낭독 speak)로
// 구성하는 순수부. 렌더러-무관(명령 이벤트 → 문장). 코어는 사실만 발행하고, 문장은 여기가 짓는다
// (MESSAGE-PROTOCOL §3). 문자열은 activity 도메인이라 여기 함께 산다.
import { makeTranslator } from "./i18n";

const EN = {
  "activity.exit": "exit",
  "activity.done.ok": "A terminal command finished.",
  "activity.done.fail": "A command failed with code",
};
const KO = {
  "activity.exit": "종료",
  "activity.done.ok": "터미널 명령이 끝났어요.",
  "activity.done.fail": "명령이 실패했어요. 코드",
};
const t = makeTranslator(EN, KO);

/** command.started → 표시만(시작은 낭독하지 않는다). `$ <명령라인>`. */
export function terminalStartedActivity(commandLine: string | null | undefined): {
  message: string;
} {
  return { message: `$ ${commandLine ?? ""}`.trimEnd() };
}

/** command.finished → 표시(종료 코드) + 낭독(성공/실패 문장). 코드 없음/0 = 성공 취급. */
export function terminalFinishedActivity(
  exitCode: number | undefined,
  lang: string,
): { message: string; speak: string } {
  return {
    message: `${t("activity.exit", lang)} ${exitCode ?? ""}`.trimEnd(),
    speak:
      exitCode == null || exitCode === 0
        ? t("activity.done.ok", lang)
        : `${t("activity.done.fail", lang)} ${exitCode}.`,
  };
}
