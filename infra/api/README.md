# API deployment

The API runs beside PostgreSQL, Storage and OpenSandbox. A remote database round trip on the development SSH connection measured 382–447 ms; serial durable event transactions multiplied that latency. Keep database authorization, transaction ordering and the ten-minute run limit intact. Local web development can forward the two API ports over SSH.

- Node 24, compiled `apps/api/dist` and `packages/contracts/dist`, root workspace manifests and the committed npm lock file.
- Install production dependencies with `npm ci --omit=dev --workspace @pivloom/api --workspace @pivloom/contracts --include-workspace-root --no-audit --no-fund` in a new `/opt/pivloom/api-releases/<release>` directory. Do not reuse macOS node_modules on Linux.
- Point `/opt/pivloom/api-current` at the verified release. Run the supplied systemd unit as the dedicated `pivloom-api` account, with home `/var/lib/pivloom-api`.
- Root provisions `/etc/pivloom/api.env` privately. It contains infrastructure configuration and the existing model-credential encryption key, **not a model provider key**. Model credentials remain in the encrypted database records configured through the UI. Omit the migration administrator URL from the runtime environment.
- API binds `127.0.0.1:18010`; preview binds `127.0.0.1:18011`. Supabase uses the existing loopback gateway at 54321, Postgres 54322, and OpenSandbox 18080. `APP_ORIGIN` and `PREVIEW_BASE_URL` must be the browser-visible origins for the current deployment.
- Stop the previous executor only when active runs have finished and retained previews have been checked. Never run two executors against this single-instance database. Restart reconciles abandoned runs, so a second development API must not be started alongside this service.
- Check `/api/v1/health/ready`, browser login and real generation after deployment, and recheck the existing site. Preserve the old release for rollback. This internal API deployment does not by itself constitute the public web release or full product acceptance.

During local web development, forward local 45310 → remote 18010 and 45311 → remote 18011. Existing local frontend and preview origins can then remain unchanged. Keep the Supabase tunnel for browser authentication and development integration tests.
