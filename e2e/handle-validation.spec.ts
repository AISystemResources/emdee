// SPRINT-113: profile handle validation shape.
//
// The `PATCH /api/profile/handle` route is auth-gated (Clerk), so end-to-end
// exercise from the browser would require the test user harness. Here we
// pin the pure validator + email-derivation behaviour that both the route
// and `ensureProfile` share, so a regression in either helper is caught in CI.

import { expect, test } from "@playwright/test";
import { validateHandle, deriveHandleFromEmail, RESERVED_HANDLES } from "@/src/lib/owner/handle";

test.describe("validateHandle", () => {
  test("accepts simple lowercase alphanumeric handles", () => {
    expect(validateHandle("edmund")).toEqual({ ok: true, handle: "edmund" });
    expect(validateHandle("a1")).toEqual({ ok: true, handle: "a1" });
    expect(validateHandle("my-handle")).toEqual({ ok: true, handle: "my-handle" });
  });

  test("lowercases + trims input", () => {
    expect(validateHandle("  Edmund  ")).toEqual({ ok: true, handle: "edmund" });
  });

  test("rejects empty and whitespace-only", () => {
    expect(validateHandle("")).toEqual({ ok: false, error: "empty" });
    expect(validateHandle("   ")).toEqual({ ok: false, error: "empty" });
  });

  test("rejects too-short (single char)", () => {
    // NB: single-char is legal per the pattern but blocked by too_short.
    expect(validateHandle("a")).toEqual({ ok: false, error: "too_short" });
  });

  test("rejects >32 chars", () => {
    expect(validateHandle("a".repeat(33))).toEqual({ ok: false, error: "too_long" });
  });

  test("rejects hyphen-boundary handles", () => {
    expect(validateHandle("-foo")).toEqual({ ok: false, error: "invalid_chars" });
    expect(validateHandle("foo-")).toEqual({ ok: false, error: "invalid_chars" });
    expect(validateHandle("foo--bar")).toEqual({ ok: true, handle: "foo--bar" }); // allowed by pattern
  });

  test("rejects non-slug chars", () => {
    expect(validateHandle("foo.bar")).toEqual({ ok: false, error: "invalid_chars" });
    expect(validateHandle("foo_bar")).toEqual({ ok: false, error: "invalid_chars" });
    expect(validateHandle("foo bar")).toEqual({ ok: false, error: "invalid_chars" });
    expect(validateHandle("foo@bar")).toEqual({ ok: false, error: "invalid_chars" });
  });

  test("rejects reserved words", () => {
    for (const r of ["admin", "api", "share", "oauth", "me"]) {
      expect(validateHandle(r), r).toEqual({ ok: false, error: "reserved" });
    }
  });
});

test.describe("deriveHandleFromEmail", () => {
  test("strips punctuation from email local-part", () => {
    expect(deriveHandleFromEmail("elz.work22@gmail.com")).toBe("elzwork22");
    expect(deriveHandleFromEmail("foo+bar@example.com")).toBe("foobar");
    expect(deriveHandleFromEmail("first.last@example.com")).toBe("firstlast");
  });

  test("lowercases", () => {
    expect(deriveHandleFromEmail("MixedCase@example.com")).toBe("mixedcase");
  });

  test("returns null for empty / too-short", () => {
    expect(deriveHandleFromEmail("a@x.com")).toBeNull();
    expect(deriveHandleFromEmail("@x.com")).toBeNull();
  });

  test("returns null when derivation collides with a reserved word", () => {
    // reserved-word candidate — the API-route path picks a suffix; the pure
    // derive helper conservatively returns null so callers must decide.
    for (const r of Array.from(RESERVED_HANDLES).slice(0, 5)) {
      expect(deriveHandleFromEmail(`${r}@example.com`)).toBeNull();
    }
  });

  test("truncates at 32 chars", () => {
    const long = "a".repeat(50) + "@example.com";
    const out = deriveHandleFromEmail(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(32);
  });
});
