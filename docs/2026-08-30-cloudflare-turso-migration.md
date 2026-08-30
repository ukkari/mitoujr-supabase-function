# Cloudflare Workers + Turso migration runbook (2026-08-30)

## Implemented state

- Turso database: `mattermost-automation`, group `default`, primary `aws-ap-northeast-1`
- Production Worker: `https://mattermost-automation.ukkaripon.workers.dev`
- Production Workflow: `daily-summary-workflow`
- Production Cron: `0 15 * * *` and `0 22 * * *`
- The former staging Worker was renamed to production so its encrypted secrets could be retained without exposing them.
- Mattermost Slash Command URLs: changed to the production Worker routes on 2026-08-31 (user-confirmed)
- Supabase Functions/Postgres/Storage: retained; all five Supabase Cron jobs are disabled

The Worker source has no Supabase runtime dependency. Supabase access exists only in the one-time migration and rollback scripts. Supabase Storage remains untouched for old audio links.

## Data verification

Supabase `reminders` was exported read-only and imported into Turso.

| Check | Supabase | Turso |
|---|---:|---:|
| Rows | 14 | 14 |
| completed | 14 | 14 |
| incomplete | 0 | 0 |
| Minimum due date | 2025-01-13 | 2025-01-13 |
| Maximum due date | 2026-08-16 | 2026-08-16 |
| Normalized SHA-256 | `749047696d4da531b41acb9c59297f38c5dd30e6dd546d77112741b0f265ff20` | same |

No reminder deliveries exist yet. Failed staging Workflow instances and temporary Mattermost content were deleted; current temporary-content row count is zero.

## Supabase Cron cutover

Dashboard read-back on 2026-08-30 found five active `pg_cron` jobs. All five were changed to `active=false` before the Cloudflare production deploy and read back as disabled afterward.

| Job | UTC schedule | JST | Target | Active after cutover |
|---|---|---|---|---|
| `invoke-function-every-minute` | `0 15 * * *` | 00:00 | `reminder-cron` | `false` |
| `mm-summary` | `0 22 * * *` | 07:00 | `today-channels-summary` | `false` |
| `mm-summary-audio` | `30 22 * * *` | 07:30 | `type=audio&lang=ja-JP` | `false` |
| `mm-summary-audio-zunda` | `45 22 * * *` | 07:45 | `type=audio&engine=voicevox` | `false` |
| `mm-summary-audio-en` | `00 23 * * *` | 08:00 | `type=audio&lang=en-US` | `false` |

All five must be disabled at cutover. Do not only disable the two schedules being recreated on Cloudflare.

## Pre-cutover staging evidence

- Worker deployed with `DRY_RUN=true`, no Cron Triggers.
- `GET /`: 404
- `GET /slash-reminder`: 404
- invalid Slash token: 403
- missing admin Bearer token: 401
- authenticated `type=audio`: 400
- real Mattermost collection was exercised without posting.
- The initial Workflow revealed that step return values are persisted. The implementation now stores temporary post bodies in Turso, emits metadata-only step outputs, clears content on success, and purges expired state from scheduled handlers.
- The account was initially on Workers Free. A real busy channel exceeded the Free subrequest limit, establishing the need for Paid before production.

The account was upgraded to Workers Paid before cutover. A one-time live test then completed Mattermost collection, text generation, image generation/upload, Mattermost posting, and temporary-content cleanup successfully. The staging Worker was subsequently renamed to the production Worker.

## Preconditions

- [x] Upgrade the Cloudflare account to Workers Paid.
- [x] Add a durable random `ADMIN_TRIGGER_SECRET` field to the 1Password `mitoujr_mattermost` item.
- [x] Configure all production Wrangler secrets.
- [x] Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to GitHub Actions secrets.

## Cutover checklist

- [x] Record the cutover timestamp for rollback sync: `2026-08-30T13:55:42Z`.
- [x] Disable all five Supabase Cron jobs above.
- [x] Read back final Supabase and Turso reminder statistics: 14 rows, all completed, identical due-date range and latest update timestamp.
- [x] Deploy the production Worker and confirm both Cloudflare Cron Triggers.
- [ ] Run an authenticated production `today` Workflow and verify text/image fallback behavior.
- [x] Update `/reminder` to `POST https://mattermost-automation.ukkaripon.workers.dev/slash-reminder` (user-confirmed on 2026-08-31).
- [x] Update `/reminder-mentors` to `POST https://mattermost-automation.ukkaripon.workers.dev/slash-reminder-mentors` (user-confirmed on 2026-08-31).
- [x] Confirm invalid token/method/admin requests remain rejected.
- [ ] Observe the 00:00 JST reminder and 07:00 JST summary for two daily cycles.
- [ ] Verify Turso state, Workflow status, Mattermost posts, and absence of duplicates.
- [ ] Retire Supabase Functions/Postgres usage and old deployment secrets.
- [ ] Keep Supabase Storage and all existing objects.

## Rollback

1. Disable Cloudflare Cron Triggers.
2. Run `npm run db:rollback-sync -- --since <cutover-ISO-timestamp>` with Turso and Supabase credentials.
3. Restore both old Mattermost Slash Command URLs.
4. Re-enable the Supabase reminder and text-summary jobs. Re-enable audio jobs only if explicitly desired; audio is intentionally removed from the new system.
