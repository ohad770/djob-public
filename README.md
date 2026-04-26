# djob-public

Public-facing jobs frontend for DJob, refactored for Vercel deployment with Supabase as the durable backend.

## Architecture
- `index.html` public jobs listing page
- `job.html` single-job page + application form
- `api/*` Vercel serverless routes
- `lib/public-core.js` shared Supabase, storage, email, and sync logic
- `legacy/server.js` previous local Express + SQLite implementation kept for reference only
- `supabase/schema.sql` SQL schema for the public jobs + applications tables

This deployment no longer uses local SQLite, local uploads, or a long-running Express server.

## Required environment variables
Set these in Vercel Project Settings:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_SYNC_SECRET`

Optional but recommended:

- `SUPABASE_PUBLIC_JOBS_TABLE` (default: `djob_public_jobs`)
- `SUPABASE_PUBLIC_APPLICATIONS_TABLE` (default: `djob_public_applications`)
- `SUPABASE_PUBLIC_RESUMES_BUCKET` (default: `djob-public-resumes`)
- `DOC_PDF_CONVERTER_URL` (required if you want to accept `.doc` uploads)
- `DOC_PDF_CONVERTER_KEY`
- `APPLICATION_NOTIFY_TO`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Supabase setup
1. Create a new Supabase project.
2. Run the SQL in `supabase/schema.sql`.
3. Deploy this repo to Vercel with the env vars above.

Notes:
- The resumes bucket is auto-created on first upload if it does not exist.
- Resume uploads are limited to `4MB`, which is safer for Vercel Functions.
- `.pdf` uploads work directly.
- `.doc` uploads are converted through your remote PDF conversion service only.

## Public API contract
The public site and the local sync engine use these endpoints:

- `GET /api/jobs`
- `GET /api/jobs/by-number/:jobNumber`
- `GET /api/positions/:positionId`
- `GET /api/categories`
- `GET /api/locations`
- `POST /api/applications`
- `POST /api/sync/jobs`
- `POST /api/sync/jobs/delete-all`
- `GET /api/sync/applications`
- `POST /api/sync/applications/delete`
- `GET /api/sync/applications/:applicationUuid/cv`

## Local development
```bash
vercel dev
```

## Vercel deployment
1. Import this repo into Vercel.
2. Add the required Supabase + sync env vars.
3. Deploy.
4. Sync jobs from the internal local server.
