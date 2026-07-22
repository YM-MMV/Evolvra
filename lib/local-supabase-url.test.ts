import { describe, expect, it } from "vitest";
import { requireLocalSupabaseUrl } from "@/lib/local-supabase-url";

describe("local Supabase destructive-test guard", () => {
  it.each([
    "http://localhost:54321",
    "http://localhost:54321/",
    "http://127.0.0.1:54321",
    "http://[::1]:54321",
  ])("accepts exact HTTP loopback URL %s", (value) => {
    expect(requireLocalSupabaseUrl(value)).toBe(new URL(value).toString());
  });

  it.each([
    undefined,
    "not a URL",
    "https://localhost:54321",
    "http://localhost.evil.test:54321",
    "http://127.0.0.1.evil.test:54321",
    "http://0.0.0.0:54321",
    "http://project.supabase.co",
    "http://user:password@localhost:54321",
    "ftp://127.0.0.1:54321",
  ])("rejects non-loopback or deceptive URL %s", (value) => {
    expect(() => requireLocalSupabaseUrl(value)).toThrow(/local|loopback|valid/i);
  });
});
