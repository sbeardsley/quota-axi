import { readFileSync, statSync } from "node:fs";
import { readCachedProvider } from "../cache.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";

const SETTINGS_URL = "https://ollama.com/settings";
const SETTINGS_TIMEOUT_MS = 10_000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

type OllamaCredentials = {
  cookie: string;
  source: AuthSourceReport;
};

type CredentialState =
  | {
      status: "available";
      credentials: OllamaCredentials;
      sources: AuthSourceReport[];
    }
  | { status: "missing" | "invalid"; sources: AuthSourceReport[] };

export const ollamaAdapter: ProviderAdapter = {
  id: "ollama",
  label: "Ollama",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const credentialState = readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({
      source: credentialState.credentials.source.source,
      status: "success",
      credentialPresent: true,
    });
    attempts.push({ source: "web", status: "failed" });
    try {
      const quota = await fetchOllamaSettings(credentialState.credentials);
      attempts[attempts.length - 1] = { source: "web", status: "success" };
      return successProvider({
        provider: "ollama",
        label: "Ollama",
        source: "web",
        windows: quota.windows,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: "web",
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    for (const source of credentialState.sources) {
      attempts.push({
        source: source.source,
        status: "skipped",
        error: credentialAttemptError(source, credentialState.status),
        credentialPresent: source.credentialPresent,
      });
    }
    finalError =
      credentialState.status === "missing"
        ? "Ollama sign-in required"
        : (credentialState.sources.find((source) => source.error)?.error ??
          "Ollama credential unavailable");
  }

  const cached = readCachedProvider("ollama");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "ollama",
    label: "Ollama",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return { provider: "ollama", sources: readCredentialState().sources };
}

export function normalizeOllamaUsage(html: string):
  | {
      windows: QuotaWindow[];
      refreshedAt: string;
    }
  | undefined {
  const session = extractUsageWindow(html, "session");
  const weekly = extractUsageWindow(html, "weekly");
  if (!session || !weekly) return undefined;
  return {
    windows: [
      withRemaining({
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: session.percentUsed,
        resetsAt: session.resetsAt,
        windowSeconds: FIVE_HOURS_SECONDS,
      }),
      withRemaining({
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: weekly.percentUsed,
        resetsAt: weekly.resetsAt,
        windowSeconds: WEEK_SECONDS,
      }),
    ],
    refreshedAt: nowIso(),
  };
}

export async function fetchOllamaSettings(
  credentials: OllamaCredentials,
): Promise<{
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);
  try {
    const response = await fetch(ollamaSettingsUrl(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie: credentials.cookie,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    rejectUnusableSettingsResponse(response);
    const html = await response.text();
    if (looksLoggedOut(html)) throw new Error("Ollama sign-in required");
    const quota = normalizeOllamaUsage(html);
    if (!quota) throw new Error("Ollama quota unavailable");
    return quota;
  } finally {
    clearTimeout(timer);
  }
}

function readCredentialState(): CredentialState {
  const cookieFile = stringValue(process.env.OLLAMA_COOKIE_PATH);
  if (cookieFile) {
    const state = readCookieFileCredential(cookieFile);
    return state.status === "available"
      ? {
          status: "available",
          credentials: { cookie: state.cookie, source: state.source },
          sources: [state.source],
        }
      : { status: state.status, sources: [state.source] };
  }

  const inline = stringValue(process.env.OLLAMA_COOKIE);
  if (inline) {
    const source: AuthSourceReport = {
      source: "auth-env",
      status: "available",
      credentialPresent: true,
    };
    return {
      status: "available",
      credentials: { cookie: inline.trim(), source },
      sources: [source],
    };
  }

  return {
    status: "missing",
    sources: [
      { source: "cookie-file", status: "missing" },
      { source: "auth-env", status: "missing" },
    ],
  };
}

function readCookieFileCredential(
  file: string,
):
  | { status: "available"; cookie: string; source: AuthSourceReport }
  | { status: "missing" | "invalid"; source: AuthSourceReport } {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    return {
      status: errorCode(error) === "ENOENT" ? "missing" : "invalid",
      source: {
        source: "cookie-file",
        path: file,
        status: errorCode(error) === "ENOENT" ? "missing" : "invalid",
        error: errorCode(error) === "ENOENT" ? undefined : "file_read_error",
      },
    };
  }
  if (!stat.isFile()) {
    return {
      status: "invalid",
      source: {
        source: "cookie-file",
        path: file,
        status: "invalid",
        error: "not_a_file",
      },
    };
  }
  if (!isOwnerOnly(stat.mode)) {
    return {
      status: "invalid",
      source: {
        source: "cookie-file",
        path: file,
        status: "invalid",
        error: "cookie_file_not_owner_only",
        credentialPresent: true,
      },
    };
  }
  let cookie: string;
  try {
    cookie = readFileSync(file, "utf8").trim();
  } catch {
    return {
      status: "invalid",
      source: {
        source: "cookie-file",
        path: file,
        status: "invalid",
        error: "file_read_error",
      },
    };
  }
  if (cookie.length === 0) {
    return {
      status: "invalid",
      source: {
        source: "cookie-file",
        path: file,
        status: "invalid",
        error: "cookie_file_empty",
      },
    };
  }
  return {
    status: "available",
    cookie,
    source: {
      source: "cookie-file",
      path: file,
      status: "available",
      credentialPresent: true,
    },
  };
}

function isOwnerOnly(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

function extractUsageWindow(
  html: string,
  name: "session" | "weekly",
): { percentUsed: number; resetsAt: string } | undefined {
  const labelPattern = new RegExp(
    `<div\\b[^>]*aria-label=(["'])([^"']*)\\1[^>]*>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(html))) {
    const aria = decodeHtmlAttribute(match[2]);
    const usage = aria.match(
      new RegExp(`^${name}\\s+usage\\s+([0-9]+(?:\\.[0-9]+)?)%`, "i"),
    );
    if (!usage) continue;
    const percentUsed = Number(usage[1]);
    if (!Number.isFinite(percentUsed)) return undefined;
    const resetsAt = extractNearbyReset(html, match.index);
    if (!resetsAt) return undefined;
    return { percentUsed: clampPercent(percentUsed), resetsAt };
  }
  return undefined;
}

function extractNearbyReset(
  html: string,
  usageIndex: number,
): string | undefined {
  const slice = html.slice(usageIndex, usageIndex + 4000);
  const match = slice.match(/\bdata-time=(["'])([^"']+)\1/i);
  return parseIso(decodeHtmlAttribute(match?.[2]));
}

function looksLoggedOut(html: string): boolean {
  if (/aria-label=(["'])(Session|Weekly)\s+usage\s+/i.test(html)) {
    return false;
  }
  return /\b(sign in|log in|signin|login)\b/i.test(stripTags(html));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function rejectUnusableSettingsResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error("Ollama sign-in required");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Ollama sign-in required");
  }
  if (response.status === 429) {
    throw new RateLimitError(
      retryAfterToIso(response.headers.get("retry-after")),
    );
  }
  if (!response.ok)
    throw new Error(`Ollama quota unavailable (${response.status})`);
}

function ollamaSettingsUrl(): string {
  return stringValue(process.env.OLLAMA_SETTINGS_URL) ?? SETTINGS_URL;
}

function parseIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function decodeHtmlAttribute(value: string | undefined): string {
  return (value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function credentialAttemptError(
  source: AuthSourceReport,
  status: "missing" | "invalid",
): string {
  return source.error ?? `credentials_${status}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Ollama quota request timed out";
  return error instanceof Error ? error.message : "Ollama quota unavailable";
}

function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Ollama settings page rate limited");
  }
}
