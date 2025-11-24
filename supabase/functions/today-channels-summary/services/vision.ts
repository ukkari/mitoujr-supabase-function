import { GoogleGenAI } from "npm:@google/genai";
import { ZUNDA_BASE64 } from "../assets/zunda-base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const aiClient = GEMINI_API_KEY
  ? new GoogleGenAI({
    apiKey: GEMINI_API_KEY,
  })
  : null;

export type SummaryImage = {
  imageBytes: Uint8Array;
  altText?: string;
};

export async function generateSummaryImage(
  summary: string,
  timeRangeDescription: string,
  dateLabelJST: string,
): Promise<SummaryImage | null> {
  if (!aiClient) {
    console.warn(
      "GEMINI_API_KEY is not set. Skipping image generation.",
    );
    return null;
  }

  const trimmedSummary = summary.length > 3500
    ? `${summary.slice(0, 3500)}...`
    : summary;

  console.log(
    "Gemini: start image generation",
    { timeRangeDescription, summaryLength: trimmedSummary.length },
  );

  const prompt =
    `Create detailed complex slide image that reflects the Mitou Jr channel updates for ${dateLabelJST} in Japanese. Please keep the user name and channel name as-is. Use the attached reference image of ずんだもん for style and character. Create dedicated column spaces for interesting and unique topics. Make it cute and visual heavy. Use emojis,illustrations and diagrams as much as possible instead of text. Base the visuals on this summary:\n${trimmedSummary}`;

  const parts: any[] = [{ text: prompt }];

  if (ZUNDA_BASE64) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: ZUNDA_BASE64,
      },
    });
  }

  const response = await aiClient.models.generateContent({
    model: "gemini-3-pro-image-preview",
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: "16:9",
        imageSize: "4K",
      },
    },
  });

  const candidate = response?.candidates?.[0];
  const responseParts = candidate?.content?.parts ?? [];

  let altText = "";
  let imageBytes: Uint8Array | null = null;

  for (const part of responseParts) {
    if ("text" in part && part.text && !altText) {
      altText = part.text;
    } else if ("inlineData" in part && part.inlineData?.data && !imageBytes) {
      const base64Data = part.inlineData.data;
      const byteCharacters = atob(base64Data);
      const bytes = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        bytes[i] = byteCharacters.charCodeAt(i);
      }
      imageBytes = bytes;
    }
  }

  console.log(
    "Gemini: response parsed",
    {
      partsCount: responseParts.length,
      altTextPreview: altText ? altText.slice(0, 80) : "",
      hasImageData: !!imageBytes,
    },
  );

  if (!imageBytes) {
    throw new Error("Gemini did not return an image");
  }

  console.log(
    "Gemini: image extracted",
    {
      byteLength: imageBytes.length,
      altTextLength: altText.length,
    },
  );

  return { imageBytes, altText };
}
