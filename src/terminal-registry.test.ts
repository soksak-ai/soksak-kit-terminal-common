import { describe, it, expect } from "vitest";
import { createTerminalRegistry } from "./terminal-registry";
import type { TerminalRenderer } from "./terminal-renderer";

const fake = (tag: string) => ({ tag }) as unknown as TerminalRenderer;

describe("createTerminalRegistry", () => {
  it("first() returns the earliest-registered terminal, or null when empty", () => {
    const reg = createTerminalRegistry();
    expect(reg.first()).toBeNull();
    reg.set("v1", fake("a"));
    reg.set("v2", fake("b"));
    expect(reg.first()?.viewId).toBe("v1");
  });

  it("resolve(view) targets a specific view, or falls back to first when unset", () => {
    const reg = createTerminalRegistry();
    reg.set("v1", fake("a"));
    reg.set("v2", fake("b"));
    expect(reg.resolve("v2")?.viewId).toBe("v2");
    expect(reg.resolve(undefined)?.viewId).toBe("v1");
    expect(reg.resolve("nope")).toBeNull(); // 지정했는데 없으면 폴백하지 않는다
  });

  it("delete drops the entry; first() advances", () => {
    const reg = createTerminalRegistry();
    reg.set("v1", fake("a"));
    reg.set("v2", fake("b"));
    reg.delete("v1");
    expect(reg.get("v1")).toBeUndefined();
    expect(reg.first()?.viewId).toBe("v2");
  });
});
