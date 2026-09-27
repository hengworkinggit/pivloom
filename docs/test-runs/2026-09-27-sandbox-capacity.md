# Three-sandbox capacity check · 2026-09-27

The host has 2 vCPUs, 3.8 GiB RAM and 2 GiB swap. `beats-steps-web.service` and
`beats-steps-pricing.service` were stopped and disabled at the owner's request;
the latter used about 581 MiB and the former about 80 MiB. Pivloom Web/API,
OpenSandbox, Caddy, Docker, Supabase and host-management services stayed live.
`MemAvailable` rose from about 1.5 to 2.1 GiB; Pivloom readiness stayed healthy.

With no user Run or Preview sandbox active, three isolated OpenSandbox/gVisor
containers were created with the production image and the normal per-container
limit of 1 CPU / 1 GiB. Each test used a 300-second lease and was explicitly
killed and closed afterward. The host monitor watched `MemAvailable` and swap
every 200–250 ms and would kill all test sandboxes below 700 MiB available or
above 128 MiB swap use.

| Concurrent workload | Result | Lowest observed available RAM | Peak swap |
| --- | --- | ---: | ---: |
| Three sandbox creations | 3/3 ready | 1,884 MiB | 0 |
| Three `npm ci` + TypeScript/Vite builds | 3/3 successful, 39 s | 1,466 MiB | 0 |
| Three Chromium sessions opening and observing a page | 3/3 successful, 14 s | 1,137 MiB (final sample) | 0 |

These are fixed infrastructure workloads, not three simultaneous real-model
projects. They establish room for a third production sandbox on this host while
the old site remains off; they do not guarantee equal latency for three complex
builds on two CPU cores. Keep the per-sandbox 1 GiB cgroup bound and the
existing queue/reclaim behavior. If production headroom proves insufficient,
set `SANDBOX_MAX_ACTIVE=2` and restart only `pivloom-api.service`; no database
migration or application revision rollback is needed.

The old site's shutdown makes `PIVLOOM_EXISTING_SITE` optional in release and
public verification scripts. When it is unset, those scripts still check the
Pivloom workbench and API but no longer require the retired site to return 200.
