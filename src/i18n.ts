// kit 공통 i18n 헬퍼 — 조회 메커니즘만 공유한다. 도메인 문자열은 각 kit 모듈이 소유한다
// (restore 문자열은 restore.ts, activity 문자열은 activity.ts). 플러그인 i18n 에 의존하지 않는다.

export type Dict = Record<string, string>;

/** en/ko 사전을 닫아 `(key, lang) => string` 번역기를 만든다. 미지정 언어는 en, 미지정 키는 key 그대로. */
export function makeTranslator(en: Dict, ko: Dict): (key: string, lang: string) => string {
  return (key, lang) => (lang === "ko" ? ko : en)[key] ?? en[key] ?? key;
}
