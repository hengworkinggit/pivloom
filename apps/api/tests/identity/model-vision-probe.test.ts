import { inflateSync } from "node:zlib";
import { expect, test } from "vitest";
import { probeModelVision } from "../../src/models/vision.js";

const input = { provider: "openai-completions" as const, baseUrl: "https://vision-fixture.invalid/v1", modelId: "fixture-vision", apiKey: "fixture-secret-not-real" };
const colors = new Map([
  ["222,48,48", "RED"], ["38,164,71", "GREEN"],
  ["45,101,223", "BLUE"], ["236,197,34", "YELLOW"],
]);

function centerColor(url: string) {
  expect(url).toMatch(/^data:image\/png;base64,/);
  const png = Buffer.from(url.split(",")[1], "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), name = png.toString("ascii", offset + 4, offset + 8);
    if (name === "IDAT") {
      const raw = inflateSync(png.subarray(offset + 8, offset + 8 + length));
      const pixel = raw.subarray(48 * (1 + 96 * 3) + 1 + 48 * 3, 48 * (1 + 96 * 3) + 1 + 48 * 3 + 3);
      return colors.get([...pixel].join(","));
    }
    offset += 12 + length;
  }
  throw new Error("Probe PNG has no pixels");
}

function completion(text: string) {
  const chunk = { id: "vision-fixture", object: "chat.completion.chunk", created: 1, model: input.modelId,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } });
}

test("Pi sends two real PNGs with image MIME, and only their pixel colors can verify vision", async () => {
  let outbound = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const images = body.messages.flatMap((message: { content: unknown }) => Array.isArray(message.content)
      ? message.content.filter((part: { type: string }) => part.type === "image_url") : []);
    outbound = images.length;
    const [a, b] = images.map((part: { image_url: { url: string } }) => centerColor(part.image_url.url));
    expect(a).toBeDefined(); expect(b).toBeDefined(); expect(a).not.toBe(b);
    return completion(`A=${a};B=${b}`);
  };
  const result = await probeModelVision(input, fetch, new AbortController().signal);
  expect(result).toMatchObject({ state: "verified", declaredImageInput: true, outboundImages: 2, answerMatched: true });
  expect(result.observedAnswer).toBe(result.expectedAnswer);
  expect(outbound).toBe(2);
});

test("a text-only or hallucinated color answer cannot verify the model", async () => {
  const result = await probeModelVision(input, async () => completion("A=RED;B=RED"), new AbortController().signal);
  expect(result).toMatchObject({ state: "failed", outboundImages: 2, answerMatched: false });
});

test("an explicit provider image rejection is unsupported; a transport failure stays unknown", async () => {
  const rejected = await probeModelVision(input, async () => new Response(JSON.stringify({ error: { message: "image input unsupported" } }),
    { status: 400, headers: { "content-type": "application/json" } }), new AbortController().signal);
  expect(rejected).toMatchObject({ state: "unsupported", answerMatched: false });
  const unavailable = await probeModelVision(input, async () => { throw new Error("connection reset"); }, new AbortController().signal);
  expect(unavailable).toMatchObject({ state: "unknown", answerMatched: false });
});
