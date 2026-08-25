import { describe, expect, it } from "vitest";
import { AVATAR_HUE_COUNT, avatarHue, avatarInitial } from "./avatar.helpers";

describe("avatarHue", () => {
  it("is deterministic for the same name", () => {
    expect(avatarHue("marat")).toBe(avatarHue("marat"));
    expect(avatarHue("work_backup")).toBe(avatarHue("work_backup"));
  });

  it("stays inside the declared hue range", () => {
    for (const name of ["a", "alice", "bob", "kirill_tv_32", "очень-длинное-имя", "_"]) {
      const hue = avatarHue(name);
      expect(hue).toBeGreaterThanOrEqual(1);
      expect(hue).toBeLessThanOrEqual(AVATAR_HUE_COUNT);
    }
  });

  it("spreads a realistic name set across more than one hue", () => {
    const names = ["marat", "lena", "work_backup", "family_pro", "olga_home", "kirill_tv_32"];
    const hues = new Set(names.map(avatarHue));
    expect(hues.size).toBeGreaterThan(1);
  });

  it("is case- and character-sensitive (different names may differ)", () => {
    expect(avatarHue("alice")).not.toBe(avatarHue("alicf"));
  });

  it("handles the empty name without throwing", () => {
    expect(avatarHue("")).toBe(1);
  });
});

describe("avatarInitial", () => {
  it("uppercases the first letter", () => {
    expect(avatarInitial("marat")).toBe("M");
    expect(avatarInitial("Olga")).toBe("O");
  });

  it("skips leading punctuation a username may legally start with", () => {
    expect(avatarInitial("_backup")).toBe("B");
    expect(avatarInitial(".hidden")).toBe("H");
    expect(avatarInitial("-x")).toBe("X");
  });

  it("accepts digits and non-latin letters", () => {
    expect(avatarInitial("7even")).toBe("7");
    expect(avatarInitial("лена")).toBe("Л");
  });

  it("falls back rather than returning an empty string", () => {
    expect(avatarInitial("___")).toBe("_");
    expect(avatarInitial("")).toBe("?");
  });
});
