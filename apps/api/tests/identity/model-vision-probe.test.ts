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

/** Answers from the tiles that really reached the endpoint, so a test only varies the wording. */
function answers(reply: (expected: string, call: number) => string) {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const images = body.messages.flatMap((message: { content: unknown }) => Array.isArray(message.content)
      ? message.content.filter((part: { type: string }) => part.type === "image_url") : []);
    const [a, b] = images.map((part: { image_url: { url: string } }) => centerColor(part.image_url.url));
    expect(a).toBeDefined(); expect(b).toBeDefined(); expect(a).not.toBe(b);
    calls++;
    return completion(reply(`A=${a};B=${b}`, calls));
  };
  return { fetch, calls: () => calls };
}

function signal() { return new AbortController().signal; }

function swapped(expected: string) {
  const [a, b] = expected.slice(2).split(";B=");
  return `A=${b};B=${a}`;
}

function wrongFirstColor(expected: string) {
  const [a, b] = expected.slice(2).split(";B=");
  return `A=${a === "RED" ? "GREEN" : "RED"};B=${b}`;
}

test("Pi sends two real PNGs with image MIME, and only their pixel colors can verify vision", async () => {
  const answering = answers((expected) => expected);
  const result = await probeModelVision(input, answering.fetch, signal());
  expect(result).toMatchObject({ state: "verified", declaredImageInput: true, outboundImages: 2, answerMatched: true, attempts: 1, verifiedOnAttempt: 1 });
  expect(result.observedAnswer).toBe(result.expectedAnswer);
  expect(answering.calls()).toBe(1);
});

test("a text-only or hallucinated color answer cannot verify the model", async () => {
  const result = await probeModelVision(input, async () => completion("A=RED;B=RED"), signal());
  expect(result).toMatchObject({ state: "failed", outboundImages: 2, answerMatched: false, verifiedOnAttempt: null });
});

test("harmless punctuation around the right colors still verifies the first sample", async () => {
  // The real false negative: a capable model answered with spacing and a trailing full stop.
  const answering = answers((expected) => ` ${expected.toLowerCase().replace("=", " = ").replace(";", " ; ")}. `);
  const result = await probeModelVision(input, answering.fetch, signal());
  expect(result).toMatchObject({ state: "verified", outboundImages: 2, answerMatched: true, attempts: 1, verifiedOnAttempt: 1 });
  expect(result.observedAnswer).not.toBe(result.expectedAnswer);
  expect(result.observedAnswer?.endsWith(".")).toBe(true);
});

test("a wrong first sample is retried with a fresh pair and verifies on the second", async () => {
  const answering = answers((expected, call) => call === 1 ? swapped(expected) : expected);
  const result = await probeModelVision(input, answering.fetch, signal());
  expect(result).toMatchObject({ state: "verified", outboundImages: 2, answerMatched: true, attempts: 2, verifiedOnAttempt: 2 });
  expect(result.observedAnswer).toBe(result.expectedAnswer);
  expect(answering.calls()).toBe(2);
});

test("a wrong colour or a swapped order still fails after every sample", async () => {
  const wrongColor = await probeModelVision(input, answers((expected) => wrongFirstColor(expected)).fetch, signal());
  expect(wrongColor).toMatchObject({ state: "failed", answerMatched: false, verifiedOnAttempt: null });
  expect(wrongColor.attempts).toBe(3);
  const wrongOrder = await probeModelVision(input, answers((expected) => swapped(expected)).fetch, signal());
  expect(wrongOrder).toMatchObject({ state: "failed", answerMatched: false, verifiedOnAttempt: null });
});

test("an explicit provider image rejection is unsupported; a transport failure stays unknown", async () => {
  const rejected = await probeModelVision(input, async () => new Response(JSON.stringify({ error: { message: "image input unsupported" } }),
    { status: 400, headers: { "content-type": "application/json" } }), signal());
  expect(rejected).toMatchObject({ state: "unsupported", answerMatched: false, verifiedOnAttempt: null });
  expect(rejected.attempts).toBe(1);
  const unavailable = await probeModelVision(input, async () => { throw new Error("connection reset"); }, signal());
  expect(unavailable).toMatchObject({ state: "unknown", answerMatched: false });
});
