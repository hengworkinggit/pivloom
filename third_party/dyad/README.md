# Dyad cancellation latch attribution

`apps/web/src/lib/use-cancellation-request-latch.ts` adapts
[`useCancellationRequestLatch.ts`](https://github.com/dyad-sh/dyad/blob/0ffb5b7333264473e61b4773ce6e25001ebd06db/src/components/chat/useCancellationRequestLatch.ts)
from Dyad commit `0ffb5b7333264473e61b4773ce6e25001ebd06db`.

The original file is outside Dyad's `src/pro` directory and is available under
Apache-2.0. The copied hook uses Pivloom Run UUIDs instead of numeric chat IDs
and lets a rejected stop request release its UI latch. The upstream `LICENSE`
and `NOTICE` are retained in this directory.
