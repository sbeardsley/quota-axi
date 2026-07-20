import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCachedProviders } from "../../src/cache.js";
import {
  fetchQuota,
  inspectAuth,
  normalizeOllamaUsage,
} from "../../src/providers/ollama.js";
import type { ProviderQuota } from "../../src/types.js";

const fixtureDir = new URL("../fixtures/ollama/", import.meta.url);
const originalCookiePath = process.env.OLLAMA_COOKIE_PATH;
const originalCookie = process.env.OLLAMA_COOKIE;
const originalSettingsUrl = process.env.OLLAMA_SETTINGS_URL;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-ollama-"));
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.OLLAMA_COOKIE_PATH;
  delete process.env.OLLAMA_COOKIE;
  delete process.env.OLLAMA_SETTINGS_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreEnv("OLLAMA_COOKIE_PATH", originalCookiePath);
  restoreEnv("OLLAMA_COOKIE", originalCookie);
  restoreEnv("OLLAMA_SETTINGS_URL", originalSettingsUrl);
  restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Ollama settings parsing", () => {
  it("normalizes session and weekly usage windows", () => {
    const result = normalizeOllamaUsage(fixture("settings-valid.html"));

    expect(result?.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 34,
        percentRemaining: 66,
        resetsAt: "2026-07-20T18:30:00.000Z",
        windowSeconds: 18000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 67,
        percentRemaining: 33,
        resetsAt: "2026-07-27T12:00:00.000Z",
        windowSeconds: 604800,
      },
    ]);
  });

  it("returns undefined for changed, partial, and logged-out markup", () => {
    expect(
      normalizeOllamaUsage(fixture("settings-changed.html")),
    ).toBeUndefined();
    expect(
      normalizeOllamaUsage(fixture("settings-partial.html")),
    ).toBeUndefined();
    expect(
      normalizeOllamaUsage(fixture("settings-logged-out.html")),
    ).toBeUndefined();
  });
});

describe("Ollama quota provider", () => {
  it("reports auth_required when no credential source is available", async () => {
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      provider: "ollama",
      label: "Ollama",
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "Ollama sign-in required",
        sourcesTried: ["cookie-file", "auth-env"],
      },
    });
  });

  it("prefers OLLAMA_COOKIE_PATH over OLLAMA_COOKIE and honors settings URL override", async () => {
    const cookieFile = writeCookieFile("ollama_session=file-cookie");
    process.env.OLLAMA_COOKIE_PATH = cookieFile;
    process.env.OLLAMA_COOKIE = "ollama_session=env-cookie";
    process.env.OLLAMA_SETTINGS_URL = "https://example.invalid/custom-settings";
    const fetchMock = vi.fn(
      async () => new Response(fixture("settings-valid.html"), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.invalid/custom-settings",
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "ollama_session=file-cookie",
        }),
        redirect: "manual",
      }),
    );
  });

  it("uses OLLAMA_COOKIE when no cookie file is configured", async () => {
    process.env.OLLAMA_COOKIE = "ollama_session=env-cookie";
    const fetchMock = vi.fn(
      async () => new Response(fixture("settings-valid.html"), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/settings",
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "ollama_session=env-cookie",
        }),
      }),
    );
  });

  it("rejects cookie files that are not owner-only", async () => {
    const cookieFile = writeCookieFile("ollama_session=file-cookie", 0o644);
    process.env.OLLAMA_COOKIE_PATH = cookieFile;
    process.env.OLLAMA_COOKIE = "ollama_session=env-cookie";

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      windows: [],
      state: {
        status: "error",
        error: "cookie_file_not_owner_only",
        sourcesTried: ["cookie-file"],
      },
    });
  });

  it("treats logged-out settings markup as auth_required", async () => {
    process.env.OLLAMA_COOKIE = "ollama_session=expired";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(fixture("settings-logged-out.html"), { status: 200 }),
      ),
    );

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.windows).toEqual([]);
  });

  it("falls back to stale cache when the settings markup is unavailable", async () => {
    process.env.OLLAMA_COOKIE = "ollama_session=valid";
    writeCachedProviders([cachedOllamaQuota()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(fixture("settings-changed.html"), { status: 200 }),
      ),
    );

    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      provider: "ollama",
      source: "cache",
      state: {
        status: "stale",
        stale: true,
        error: "Ollama quota unavailable",
        sourcesTried: ["auth-env", "web", "cache"],
      },
    });
    expect(result.windows[0]).toMatchObject({
      id: "five_hour",
      percentRemaining: 90,
    });
  });

  it("does not expose cookie values in auth inspection", async () => {
    const cookieFile = writeCookieFile("ollama_session=secret-cookie");
    process.env.OLLAMA_COOKIE_PATH = cookieFile;

    const result = await inspectAuth({ allowKeychainPrompt: false });
    const serialized = JSON.stringify(result);

    expect(result.sources).toEqual([
      {
        source: "cookie-file",
        path: cookieFile,
        status: "available",
        credentialPresent: true,
      },
    ]);
    expect(serialized).not.toContain("secret-cookie");
  });

  it("times out a hung settings request", async () => {
    vi.useFakeTimers();
    process.env.OLLAMA_COOKIE = "ollama_session=valid";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );

    const promise = fetchQuota({ allowKeychainPrompt: false });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result).toMatchObject({
      windows: [],
      state: {
        status: "error",
        error: "Ollama quota request timed out",
      },
    });
  });
});

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), "utf8");
}

function writeCookieFile(value: string, mode = 0o600): string {
  const file = join(tempDir!, "ollama.cookie");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

function cachedOllamaQuota(): ProviderQuota {
  return {
    provider: "ollama",
    label: "Ollama",
    source: "web",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 10,
        percentRemaining: 90,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-07-20T12:00:00Z",
      sourcesTried: ["auth-env", "web"],
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
