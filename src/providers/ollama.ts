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
const SETTINGS_USER_AGENT = "quota-axi";
const SETTINGS_TIMEOUT_MS = 10_000;
const RESET_SCAN_LIMIT = 4000;
const DOCUMENT_LEVEL_ELEMENTS = new Set(["html", "body", "main"]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
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
  const labels = collectUsageLabels(html);
  const session = extractUsageWindow(html, labels, "session");
  const weekly = extractUsageWindow(html, labels, "weekly");
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
    const response = await fetch(SETTINGS_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie: credentials.cookie,
        "user-agent": SETTINGS_USER_AGENT,
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

type UsageLabel = {
  name: "session" | "weekly";
  percentUsed: number;
  index: number;
};

function collectUsageLabels(html: string): UsageLabel[] {
  const labelPattern = /<div\b[^>]*aria-label=(["'])([^"']*)\1[^>]*>/gi;
  const labels: UsageLabel[] = [];
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(html))) {
    const aria = decodeHtmlAttribute(match[2]);
    const usage = aria.match(
      /^(session|weekly)\s+usage\s+([0-9]+(?:\.[0-9]+)?)%/i,
    );
    if (!usage) continue;
    labels.push({
      name: usage[1].toLowerCase() as "session" | "weekly",
      percentUsed: Number(usage[2]),
      index: match.index,
    });
  }
  return labels;
}

function extractUsageWindow(
  html: string,
  labels: UsageLabel[],
  name: "session" | "weekly",
): { percentUsed: number; resetsAt: string } | undefined {
  const matches = labels.filter((label) => label.name === name);
  if (matches.length !== 1) return undefined;
  const label = matches[0];
  if (!Number.isFinite(label.percentUsed)) return undefined;
  const resetsAt = extractScopedReset(html, labels, label);
  if (!resetsAt) return undefined;
  return { percentUsed: clampPercent(label.percentUsed), resetsAt };
}

function extractScopedReset(
  html: string,
  labels: UsageLabel[],
  label: UsageLabel,
): string | undefined {
  const block = findUsageBlock(html, labels, label);
  if (!block) return undefined;
  const end = Math.min(block.end, label.index + RESET_SCAN_LIMIT);
  const slice = html.slice(label.index, end);
  const match = slice.match(/\bdata-time=(["'])([^"']+)\1/i);
  return parseIso(decodeHtmlAttribute(match?.[2]));
}

function findUsageBlock(
  html: string,
  labels: UsageLabel[],
  label: UsageLabel,
): ElementRange | undefined {
  const otherLabels = labels
    .filter((other) => other.index !== label.index)
    .map((other) => other.index);
  let block: ElementRange | undefined;
  for (const range of enclosingElements(html, label.index)) {
    if (DOCUMENT_LEVEL_ELEMENTS.has(range.name)) break;
    if (
      otherLabels.some((other) => other >= range.start && other < range.end)
    ) {
      break;
    }
    block = range;
  }
  return block;
}

type ElementRange = { name: string; start: number; end: number };

function enclosingElements(html: string, index: number): ElementRange[] {
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)>/g;
  const open: { name: string; start: number }[] = [];
  const enclosing: { name: string; start: number; end?: number }[] = [];
  let captured = false;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html))) {
    const [raw, closing, rawName, selfClosing] = match;
    const name = rawName.toLowerCase();

    if (!closing) {
      if (VOID_ELEMENTS.has(name) || selfClosing) continue;
      if (RAW_TEXT_ELEMENTS.has(name)) {
        const closeIndex = html
          .toLowerCase()
          .indexOf(`</${name}`, tagPattern.lastIndex);
        if (closeIndex < 0) break;
        tagPattern.lastIndex = closeIndex;
        continue;
      }
      open.push({ name, start: match.index });
      if (!captured && match.index === index) {
        enclosing.push(...open.map((entry) => ({ ...entry })));
        captured = true;
      }
      continue;
    }

    const depth = findOpenDepth(open, name);
    if (depth < 0) continue;
    const end = match.index + raw.length;
    for (let i = open.length - 1; i >= depth; i--) {
      const pending = enclosing.find(
        (entry) => entry.start === open[i].start && entry.end === undefined,
      );
      if (pending) pending.end = end;
    }
    open.length = depth;
    if (captured && enclosing.every((entry) => entry.end !== undefined)) break;
  }

  return enclosing
    .filter((entry): entry is ElementRange => entry.end !== undefined)
    .reverse();
}

function findOpenDepth(
  open: { name: string; start: number }[],
  name: string,
): number {
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i].name === name) return i;
  }
  return -1;
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
  if (response.status === 401) {
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
