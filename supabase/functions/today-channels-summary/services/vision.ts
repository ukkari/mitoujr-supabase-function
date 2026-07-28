import OpenAI, { toFile } from "npm:openai@7.0.0";
import { ZUNDA_BASE64 } from "../assets/zunda-base64.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_IMAGE_MODEL = "gpt-image-2";
const OPENAI_IMAGE_SIZE = "1792x1008";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

export type SummaryImage = {
  imageBytes: Uint8Array;
  altText?: string;
};

export async function generateSummaryImage(
  summary: string,
  timeRangeDescription: string,
  dateLabelJST: string,
): Promise<SummaryImage | null> {
  if (!OPENAI_API_KEY) {
    console.warn(
      "OPENAI_API_KEY is not set. Skipping image generation.",
    );
    return null;
  }

  const trimmedSummary = summary.length > 3500
    ? `${summary.slice(0, 3500)}...`
    : summary;

  console.log(
    "OpenAI: start image generation",
    {
      model: OPENAI_IMAGE_MODEL,
      size: OPENAI_IMAGE_SIZE,
      timeRangeDescription,
      summaryLength: trimmedSummary.length,
    },
  );

  const prompt =
    `Create a polished 16:9 landscape infographic illustration that reflects the Mitou Jr Mattermost channel updates for ${dateLabelJST}. Make it illustration-first: communicate through cute scenes, expressive characters, icons, emojis, and simple diagrams, with only short Japanese headings and labels where needed. Preserve user names and channel names exactly as provided. Use the attached ずんだもん image as the character and style reference. Organize interesting and unique topics into clearly separated illustrated cards or scenes. Avoid paragraphs and dense text. Mattermost strings such as ":kusa:" are custom emojis; do not render the literal colon syntax. Replace them with a suitable visual symbol or omit them when unclear. Do not invent names, channel names, dates, or facts. Base the illustration only on this summary:\n${trimmedSummary}`;

  if (!ZUNDA_BASE64) {
    throw new Error("Zundamon reference image is not configured");
  }

  const referenceBytes = decodeBase64(ZUNDA_BASE64);
  const referenceImage = await toFile(
    referenceBytes,
    "zundamon-reference.png",
    { type: "image/png" },
  );

  const response = await openai.images.edit({
    model: OPENAI_IMAGE_MODEL,
    image: referenceImage,
    prompt,
    size: OPENAI_IMAGE_SIZE,
    quality: "medium",
    output_format: "png",
  });

  const base64Data = response.data?.[0]?.b64_json;
  if (!base64Data) {
    throw new Error("OpenAI image API did not return image data");
  }

  const imageBytes = decodeBase64(base64Data);
  const altText =
    `${dateLabelJST}の未踏ジュニアMattermost投稿を、ずんだもんと共にまとめたインフォグラフィック`;

  console.log(
    "OpenAI: image generated",
    {
      model: OPENAI_IMAGE_MODEL,
      size: OPENAI_IMAGE_SIZE,
      byteLength: imageBytes.length,
      requestId: response._request_id,
    },
  );

  return { imageBytes, altText };
}

function decodeBase64(data: string): Uint8Array {
  const byteCharacters = atob(data);
  const bytes = new Uint8Array(byteCharacters.length);

  for (let i = 0; i < byteCharacters.length; i++) {
    bytes[i] = byteCharacters.charCodeAt(i);
  }

  return bytes;
}
