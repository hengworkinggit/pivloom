import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";
import { normalizeContext, type AssistantMessage, type Context, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { stream as openAIStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { CreateModelProfile, ModelCapabilities } from "@pivloom/contracts";

type Connection = Pick<CreateModelProfile, "provider" | "baseUrl" | "modelId" | "apiKey">;
type VisionState = ModelCapabilities["vision"];
type Color = "RED" | "GREEN" | "BLUE" | "YELLOW";
const colors: ReadonlyArray<{ name: Color; rgb: readonly [number, number, number] }> = [
  { name: "RED", rgb: [222, 48, 48] }, { name: "GREEN", rgb: [38, 164, 71] },
  { name: "BLUE", rgb: [45, 101, 223] }, { name: "YELLOW", rgb: [236, 197, 34] },
];
const palette: ReadonlyArray<string> = colors.map((color) => color.name);
/**
 * One sample decided the verdict before, and a single flaky or oddly worded answer marked a
 * capable model unusable: deepseek-flash was reported "failed", then verified on a manual
 * retry of the same configuration. Three samples ride out one bad answer while keeping the
 * probe a small bounded test.
 */
const MAX_ATTEMPTS = 3;
/**
 * probe.ts wraps this probe in a 40s abort, and retries must spend only the time left inside
 * that ceiling instead of extending it. Each sample therefore gets the remaining budget as
 * its own timeout, so a hung provider still ends the whole probe at 40s.
 */
const PROBE_BUDGET_MS = 40_000;

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Buffer) {
  const label = Buffer.from(name, "ascii");
  const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([header, label, data, checksum]);
}

/** A disposable probe image. Its randomly selected color exists only in PNG pixels. */
function colorTile(rgb: readonly [number, number, number]): ImageContent {
  const width = 96, height = 96;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      const pixel = x >= 12 && x < 84 && y >= 12 && y < 84 ? rgb : [255, 255, 255];
      raw[offset] = pixel[0]; raw[offset + 1] = pixel[1]; raw[offset + 2] = pixel[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
  return { type: "image", mimeType: "image/png", data: png.toString("base64") };
}

/**
 * Reads the ordered A/B colors out of a free-form answer. A capable model replied
 * "A=RED; B=BLUE." and plain string equality reported it as unusable for visual
 * verification, so punctuation and spacing around the words are ignored. Tolerance stops
 * there: both colors must be named and must arrive in A-then-B order, so a wrong or swapped
 * pair still fails.
 */
function parseColorPair(answer: string): string | null {
  const words = answer.toUpperCase().match(/[A-Z]+/g) ?? [];
  const picked: string[] = [];
  for (let index = 0; index < words.length && picked.length < 2; index++) {
    if (words[index] !== (picked.length === 0 ? "A" : "B")) continue;
    const color = words.slice(index + 1).find((word) => palette.includes(word));
    if (color) picked.push(color);
  }
  return picked.length === 2 ? `A=${picked[0]};B=${picked[1]}` : null;
}

export interface VisionProbeResult {
  state: VisionState;
  /** These flags are safe to persist; they never include image bytes or credentials. */
  declaredImageInput: boolean;
  outboundImages: number;
  answerMatched: boolean;
  /** Samples attempted before the probe stopped; above one means a retry decided the verdict. */
  attempts: number;
  /** 1-based index of the sample that recognized the images, or null when none did. */
  verifiedOnAttempt: number | null;
  expectedAnswer: string;
  observedAnswer: string | null;
}

/** Uses Pi's image message conversion and the exact selected provider connection. */
export async function probeModelVision(input: Connection, fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<VisionProbeResult> {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const common = {
    id: input.modelId, name: input.modelId, provider: "pivloom-byok", baseUrl: input.baseUrl,
    reasoning: false, input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 128,
  };
  interface Sample { expected: string; observed: string | null; outboundImages: number }
  let attempts = 0;
  let verifiedOnAttempt: number | null = null;
  let answered: Sample | null = null;
  let lastSent: { expected: string; outboundImages: number } | null = null;
  let refusedImages = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Never start a sample the caller's 40s abort would cut off mid-flight.
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0) break;
    // A fresh pair per sample keeps a stale or lucky answer from deciding the verdict.
    const first = randomInt(colors.length);
    const second = (first + 1 + randomInt(colors.length - 1)) % colors.length;
    const imageA = colorTile(colors[first].rgb), imageB = colorTile(colors[second].rgb);
    const expected = `A=${colors[first].name};B=${colors[second].name}`;
    const context: Context = {
      systemPrompt: "Identify the center-square colors in the two attached images. Return only A=COLOR;B=COLOR, using RED, GREEN, BLUE or YELLOW. The colors are not stated in text.",
      messages: [{ role: "user", content: [
        { type: "text", text: "Image A:" }, imageA,
        { type: "text", text: "Image B:" }, imageB,
        { type: "text", text: "Give both colors in order." },
      ], timestamp: Date.now() }],
    };
    let outboundImages = 0;
    const checkedFetch: typeof globalThis.fetch = (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      outboundImages = [imageA, imageB].filter((image) => body.includes(image.data) && body.includes(image.mimeType)).length;
      // A text-only payload must never be mistaken for a successful vision probe.
      if (outboundImages !== 2) throw new Error("IMAGE_PAYLOAD_MISSING");
      return fetch(url, init);
    };
    const options = { apiKey: input.apiKey, fetch: checkedFetch, signal, maxTokens: 128, timeoutMs: remaining, maxRetries: 0 };
    attempts++;
    try {
      const stream = input.provider === "openai-completions"
        ? openAIStream({ ...common, api: "openai-completions", compat: { supportsStore: false, supportsDeveloperRole: false } } satisfies Model<"openai-completions">, normalizeContext(context), options)
        : anthropicStream({ ...common, api: "anthropic-messages" } satisfies Model<"anthropic-messages">, normalizeContext(context), options);
      let result: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "VISION_PROVIDER_ERROR");
        if (event.type === "done") result = event.message;
      }
      const answer = result?.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim() ?? "";
      answered = { expected, observed: answer || null, outboundImages };
      if (parseColorPair(answer) === expected) { verifiedOnAttempt = attempt; break; }
    } catch (error) {
      lastSent = { expected, outboundImages };
      const message = error instanceof Error ? error.message : "";
      // Our own payload guard is deterministic, and a provider that names image input in its
      // refusal is answering a capability question rather than failing transiently, so neither
      // is repaired by resending the same images.
      if (message.includes("IMAGE_PAYLOAD_MISSING")) break;
      if (/(?:image|vision|multimodal|图片|视觉).*(?:not supported|unsupported|invalid|不支持)|(?:not supported|unsupported|不支持).*(?:image|vision|multimodal|图片|视觉)/i.test(message)) { refusedImages = true; break; }
    }
  }
  const state: VisionState = verifiedOnAttempt !== null ? "verified" : answered ? "failed" : refusedImages ? "unsupported" : "unknown";
  return {
    state, declaredImageInput: true,
    outboundImages: answered?.outboundImages ?? lastSent?.outboundImages ?? 0,
    answerMatched: verifiedOnAttempt !== null,
    attempts, verifiedOnAttempt,
    expectedAnswer: answered?.expected ?? lastSent?.expected ?? "",
    observedAnswer: answered?.observed ?? null,
  };
}
