# Repository Guidelines

## Project Structure & Modules
- `supabase/functions/` — edge functions written in TypeScript for Deno. Each function lives in its own folder (`today-channels-summary`, `slash-reminder-mentors`, `reminder-cron`) with an `index.ts`.
- `supabase/functions/_shared/` — reusable helpers for Supabase client setup, Mattermost API, admin access, and CORS.
- `supabase/config.toml` — Supabase local project config; keep in sync with the CLI.
- `main.http` — HTTP request samples for local testing.
- `node_modules/`, `package-lock.json` — only include when CLI dependencies are needed; avoid committing extra dev artifacts.

## Build, Test, and Development Commands
- `supabase start` — launch local Supabase stack (Postgres, auth, storage) for integration testing.
- `supabase functions serve today-channels-summary --env-file supabase/functions/.env` — run the primary function locally with live reload.
- `supabase functions deploy today-channels-summary` — deploy the function to the Supabase project.
- `npx supabase secrets set --env-file ./supabase/functions/.env` — push local env values to Supabase (required before deploy).
- `deno fmt supabase/functions/**/*.ts` — format TypeScript when editing Deno code.

## Coding Style & Naming
- TypeScript targeting Deno runtime; prefer ES module imports and explicit `const`.
- File and folder names use kebab-case (`today-channels-summary`).
- Keep functions small and pure where possible; push shared logic into `_shared`.
- Format with `deno fmt`; avoid trailing console logs except in debug sections with guards.
- Use async/await with proper error handling; return JSON responses with clear status codes.

## Testing Guidelines
- No automated test suite yet; rely on `supabase functions serve` plus `curl`/`main.http` requests to verify responses.
- When adding tests, mirror Deno’s standard test runner and place files beside implementations (e.g., `index.test.ts`).
- Manually confirm Mattermost interactions in a test channel before production deploys.

## Commit & Pull Request Guidelines
- Commit messages follow short, imperative summaries (see `git log`, e.g., “Enhance today-channels-summary prompt…”). Keep under ~72 chars.
- Each PR should include: purpose, key changes, manual test notes/commands, and any related issue IDs.
- Add screenshots or sample JSON responses when UI/API behavior changes.
- Ensure `supabase/functions/.env` updates are documented but never committed; prefer `.env.example` if adding new keys.

## Environment & Security Notes
- Required env keys (per functions): `MATTERMOST_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, VoiceVox settings, etc. Keep them in `supabase/functions/.env`.
- Do not log secrets; wrap verbose logging behind the `debug` query flag where implemented.
- Storage uploads (audio generation) rely on service role keys—limit scope to deploy/runtime contexts only.
