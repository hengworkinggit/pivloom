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

export interface VisionProbeResult {
  state: VisionState;
  /** These flags are safe to persist; they never include image bytes or credentials. */
  declaredImageInput: boolean;
  outboundImages: number;
  answerMatched: boolean;
  expectedAnswer: string;
  observedAnswer: string | null;
}

/** Uses Pi's image message conversion and the exact selected provider connection. */
export async function probeModelVision(input: Connection, fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<VisionProbeResult> {
  const first = randomInt(colors.length);
  const second = (first + 1 + randomInt(colors.length - 1)) % colors.length;
  const imageA = colorTile(colors[first].rgb), imageB = colorTile(colors[second].rgb);
  const expected = `A=${colors[first].name};B=${colors[second].name}`;
  const common = {
    id: input.modelId, name: input.modelId, provider: "pivloom-byok", baseUrl: input.baseUrl,
    reasoning: false, input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 128,
  };
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
  const options = { apiKey: input.apiKey, fetch: checkedFetch, signal, maxTokens: 128, timeoutMs: 40_000, maxRetries: 0 };
  try {
    const stream = input.provider === "openai-completions"
      ? openAIStream({ ...common, api: "openai-completions", compat: { supportsStore: false, supportsDeveloperRole: false } } satisfies Model<"openai-completions">, normalizeContext(context), options)
      : anthropicStream({ ...common, api: "anthropic-messages" } satisfies Model<"anthropic-messages">, normalizeContext(context), options);
    let result: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "error") throw new Error(event.error.errorMessage ?? "VISION_PROVIDER_ERROR");
      if (event.type === "done") result = event.message;
    }
    const answer = result?.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim().toUpperCase().replace(/\s+/g, "");
    const answerMatched = outboundImages === 2 && answer === expected;
    return { state: answerMatched ? "verified" : "failed", declaredImageInput: true, outboundImages, answerMatched,
      expectedAnswer: expected, observedAnswer: answer ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const explicitRejection = /(?:image|vision|multimodal|图片|视觉).*(?:not supported|unsupported|invalid|不支持)|(?:not supported|unsupported|不支持).*(?:image|vision|multimodal|图片|视觉)/i.test(message);
    return { state: explicitRejection ? "unsupported" : "unknown", declaredImageInput: true, outboundImages, answerMatched: false,
      expectedAnswer: expected, observedAnswer: null };
  }
}
