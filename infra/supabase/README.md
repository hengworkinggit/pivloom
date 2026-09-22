# Minimal self-hosted Supabase for Pivloom development

Validated on the authorized Ubuntu host: Auth, Postgres, PostgREST and file-backed private Storage. All host ports bind to 127.0.0.1; access during development is through SSH tunnels. Existing Caddy serves the loopback-only gateway by importing gateway.caddy. Do not expose these control/database ports publicly.

The deployed /opt/pivloom/supabase/.env is owner-only and contains generated POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_PUBLIC_URL and APP_ORIGIN. Values are not committed. On a fresh installation, generate consistent HS256 anon/service role JWTs from the same JWT_SECRET before starting Compose; do not substitute model credentials. The frontend receives only the anonymous publishable key. Server-side model encryption uses a separate key.

Run docker compose up -d from the deployment directory after private .env preparation. Verify all four services healthy before running the repository migration and identity seed tools. Do not remove named data/object volumes to fix a startup error. The minimal roles script intentionally omits the functions role because this stack does not deploy Edge Functions or webhooks.

Auth CORS explicitly permits the Supabase SDK apikey header. Storage health checks use IPv4 because its service does not listen on ::1. The gateway file contains no credentials; validate Caddy before reloading and preserve the existing site configuration.

Full validation and the limits of this single-task deployment: ../../docs/foundation-validation-2026-09-22.md. This minimal stack does not include Studio, Realtime, Analytics, Edge Functions, Pooler or image transformations. Private file storage is persisted in the objects volume; no MinIO is required for this tested path.
