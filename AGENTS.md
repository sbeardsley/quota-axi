# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- quota-axi is data only.
- It reports local Claude and Codex quota windows, and it must never route, recommend, proxy, intercept, log in, import browser cookies, or mutate provider state.
- Claude quota windows can include `five_hour`, `seven_day`, `seven_day_opus`, and `extra_usage`. When the OAuth usage response includes a `limits` array, that array is the authoritative, self-describing source and is preferred over the fixed top-level fields: it surfaces every active limit, including ones scoped to a specific model (e.g. Fable) via `scope.model.display_name`, with a `model:<slug>` window id.
- Codex quota windows can include `five_hour` and `weekly`, plus optional credit balance data. Codex responses can also carry extra limits scoped to a specific model or feature (HTTP: `additional_rate_limits`; app-server RPC: `rateLimitsByLimitId`), surfaced as `model:<id>:5h` / `model:<id>:7d` windows.
- Provider adapter behavior (retry-after handling, snake/camel field tolerance, window parsing) is an original, clean-room implementation derived only from the vendors' own OAuth/HTTP behavior; quota-axi carries no vendored or attributed third-party adapter code.
- Default stdout is compact TOON.
- `--json` emits the normalized model, and `--full` is required before account identity or per-source attempts are shown.
- JSON provider reports include `provider`, `label`, `source`, `windows`, and `state`; `state.retryAfter` can appear for provider rate limits.
- macOS Claude Keychain reads are skipped by default because they can prompt.
- `--allow-keychain-prompt` is the only v1 opt-in for that behavior.
- Codex uses `$CODEX_HOME/auth.json` or `~/.codex/auth.json` OAuth before the CLI fallback.
- Codex `auth.json` support is OAuth-token only; never treat `OPENAI_API_KEY` as valid quota auth or send API keys to ChatGPT quota endpoints.
- Never launch the Claude CLI to probe quota, because that would spend the quota being measured.
- The read-only Codex app-server JSON-RPC probe is the only CLI fallback.
- The cache path is `~/.cache/quota-axi/quotas.json`, or under `$XDG_CACHE_HOME/quota-axi/` when `XDG_CACHE_HOME` is set.
- Cache files must be `0600` and contain only normalized non-secret snapshots.
- Only fresh provider snapshots with windows are cached.
- Failed providers, stale providers, account identity, and source attempts are not cached.
- Do not cache raw provider responses or credential headers.

## Development

```sh
pnpm install
pnpm run build
pnpm test
```

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
