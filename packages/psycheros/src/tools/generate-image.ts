/**
 * Image Generation Tool Implementation
 *
 * I use this tool to generate images through configured providers
 * (OpenRouter/Venice, Gemini, ComfyUI, or native). I choose the appropriate generator
 * based on context, and can include anchor images for style/character
 * consistency or user-uploaded images as references.
 */

import { join } from "@std/path";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { ImageGenConfig } from "../llm/image-gen-settings.ts";
import { captionImageDual } from "./describe-image.ts";

// =============================================================================
// Tool Definition
// =============================================================================

export const generateImageTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "I use this to generate an image or iterate on a previous one. I choose the appropriate generator_id " +
        "based on the user's request and available generators. I can include " +
        "anchor_images by ID as style/character references, user_image_path " +
        "if the user provided an image with their message, or input_image_path " +
        "with a path to a previously generated image for reference-based iteration. " +
        "Images I generate appear as actual images in the conversation automatically. " +
        "I do NOT output [IMAGE:] markers or image code in my text — I simply describe " +
        "or discuss the image naturally, and it will appear visually for the user.",
      parameters: {
        type: "object",
        properties: {
          generator_id: {
            type: "string",
            description:
              "The ID (not the display name) of the image generator to use. The ID is the alphanumeric string shown after 'ID:' in the generators list (e.g. 'a1b2c3d4').",
          },
          prompt: {
            type: "string",
            description:
              "The image generation prompt describing what I want to create",
          },
          negative_prompt: {
            type: "string",
            description:
              "Optional negative prompt — things I want to avoid in the image",
          },
          anchor_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of anchor image IDs to include as style/character references",
          },
          user_image_path: {
            type: "string",
            description:
              "Optional path to a user-uploaded image to use as reference",
          },
          input_image_path: {
            type: "string",
            description:
              "Optional path to an existing image to use as a starting reference for iteration/modification",
          },
          aspect_ratio: {
            type: "string",
            description:
              "Optional aspect ratio for the generated image. Supported values: '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '5:4', '4:5', '21:9'. If not provided, uses the generator's default.",
          },
        },
        required: ["generator_id", "prompt"],
      },
    },
  },
  execute,
};

// =============================================================================
// OpenRouter Provider (Venice Wrapper)
// =============================================================================

async function generateViaOpenRouter(
  config: ImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
  anchorImages: Array<{ data: string; mediaType: string }>,
  userImage: { data: string; mediaType: string } | undefined,
  inputImage: { data: string; mediaType: string } | undefined,
): Promise<{ imageData: string; mediaType: string }> {
  // Use openrouter settings from config to maintain frontend compatibility,
  // but we route this to the Venice API.
  const settings = config.settings.openrouter;
  
  if (!settings) {
    throw new Error("OpenRouter (Venice) settings not configured for this generator");
  }

  // Override the baseUrl to Venice if the default OpenRouter one is still present
  let baseUrl = (settings.baseUrl || "https://api.venice.ai/api/v1").trim().replace(/\/+$/, "");
  if (baseUrl.includes("openrouter.ai")) {
    baseUrl = "https://api.venice.ai/api/v1";
  }
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${sanitizeHeaderValue(settings.apiKey)}`,
  };

  // Venice's /image/generate does not utilize an array of vision-messages for anchor references
  // like OpenRouter did. If these are provided, we log a warning for visibility.
  if (anchorImages.length > 0 || userImage) {
    console.warn(
      "[ImageGen] Venice /image/generate endpoint does not natively support array-based anchor " +
      "or user reference images. They will be ignored unless the active model explicitly supports them."
    );
  }

  const params = config.settings.params || {};

  const body: Record<string, unknown> = {
    model: settings.model,
    prompt: prompt,
    return_binary: false, // Ensures we receive a JSON response with base64 data
    hide_watermark: true,
    safe_mode: false,    
    // You can also add other hardcoded defaults here:
    // cfg_scale: 7.5,
    // steps: 8,
  };

  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }

  // Handle Venice sizing options (models accept aspect_ratio or explicit dimensions)
  if (params.aspect_ratio) {
    body.aspect_ratio = params.aspect_ratio;
  } else if (params.width && params.height) {
    body.width = params.width;
    body.height = params.height;
  }

  // If iterating on an input image, Venice utilizes an 'image' parameter
  if (inputImage) {
    body.image = `data:${inputImage.mediaType};base64,${inputImage.data}`;
  }

  const response = await fetch(`${baseUrl}/image/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Venice API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // Venice returns base64 strings in the 'images' array
  const images = data.images as string[] | undefined;
  
  if (!images || images.length === 0 || !images[0]) {
    // Fallback for OpenAI compatible response structures (in case of endpoint drift)
    const openaiData = data.data as Array<{b64_json?: string}> | undefined;
    if (openaiData?.[0]?.b64_json) {
       return { imageData: openaiData[0].b64_json, mediaType: "image/png" };
    }
    console.error("[ImageGen] Unrecognized Venice payload keys:", Object.keys(data));
    throw new Error("Venice response did not contain a generated image array");
  }

  let base64Data = images[0];
  let mediaType = "image/png"; // Default fallback
  
  // Extract clean base64 data if the payload included a data URI prefix
  const dataMatch = base64Data.match(/^data:(image\/\w+);base64,(.+)$/);
  if (dataMatch) {
    mediaType = dataMatch[1];
    base64Data = dataMatch[2];
  }

  return { imageData: base64Data, mediaType };
}

// =============================================================================
// Gemini Provider
// =============================================================================

/**
 * Map width/height to the closest supported Gemini aspect ratio string.
 * Returns "1:1" if no close match is found.
 */
function mapToAspectRatio(width: number, height: number): string {
  const ratio = width / height;
  const candidates: Array<{ ratio: number; label: string }> = [
    { ratio: 1, label: "1:1" },
    { ratio: 4 / 3, label: "4:3" },
    { ratio: 3 / 4, label: "3:4" },
    { ratio: 3 / 2, label: "3:2" },
    { ratio: 2 / 3, label: "2:3" },
    { ratio: 16 / 9, label: "16:9" },
    { ratio: 9 / 16, label: "9:16" },
    { ratio: 5 / 4, label: "5:4" },
    { ratio: 4 / 5, label: "4:5" },
    { ratio: 21 / 9, label: "21:9" },
  ];
  let best = candidates[0];
  let bestDiff = Math.abs(ratio - best.ratio);
  for (const c of candidates) {
    const diff = Math.abs(ratio - c.ratio);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.label;
}

/**
 * Derive imageSize from the configured width (Gemini uses "1K", "2K", "4K" tokens).
 */
function mapToImageSize(width: number): string {
  if (width >= 4096) return "4K";
  if (width >= 2048) return "2K";
  return "1K"; // default
}

async function generateViaGemini(
  config: ImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
  anchorImages: Array<{ data: string; mediaType: string }>,
  userImage: { data: string; mediaType: string } | undefined,
  inputImage: { data: string; mediaType: string } | undefined,
): Promise<{ imageData: string; mediaType: string }> {
  const settings = config.settings.gemini;
  if (!settings) {
    throw new Error("Gemini settings not configured for this generator");
  }

  const model = settings.model || "gemini-2.0-flash-exp-image-generation";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Build parts — text prompt + reference images
  const parts: Array<
    | { text: string }
    | { inline_data: { mime_type: string; data: string } }
  > = [];

  // If there's a negative prompt, fold it into the prompt semantically
  // (Gemini doesn't have a negative prompt parameter)
  let fullPrompt = prompt;
  if (negativePrompt) {
    fullPrompt += `\n\nStyle requirements: avoid ${negativePrompt}.`;
  }
  parts.push({ text: fullPrompt });

  // Add anchor images as inline_data references
  for (const img of anchorImages) {
    parts.push({
      inline_data: {
        mime_type: img.mediaType,
        data: img.data,
      },
    });
  }

  // Add user-uploaded image as inline_data reference
  if (userImage) {
    parts.push({
      inline_data: {
        mime_type: userImage.mediaType,
        data: userImage.data,
      },
    });
  }

  // Add input image for iteration as inline_data reference
  if (inputImage) {
    parts.push({
      inline_data: {
        mime_type: inputImage.mediaType,
        data: inputImage.data,
      },
    });
  }

  // Build generation config
  const params = config.settings.params;
  const aspectRatio = params.aspect_ratio ||
    mapToAspectRatio(params.width, params.height);
  const imageSize = mapToImageSize(params.width);

  const body: Record<string, unknown> = {
    contents: [{
      role: "user",
      parts,
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: imageSize,
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": sanitizeHeaderValue(settings.apiKey),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<Record<string, unknown>>;
      };
      finishReason?: string;
    }>;
  };

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error("Gemini returned no candidates in the response");
  }

  // Find the first non-thought image part
  for (const candidate of data.candidates) {
    if (!candidate.content?.parts) continue;
    for (const part of candidate.content.parts) {
      const isThought = (part.thought as boolean) ?? false;
      const inlineData = (part.inlineData ?? part.inline_data) as {
        mimeType?: string;
        data: string;
      } | undefined;
      if (inlineData && !isThought) {
        return {
          imageData: inlineData.data,
          mediaType: inlineData.mimeType || "image/png",
        };
      }
    }
  }

  throw new Error("Gemini response did not contain a generated image");
}

// =============================================================================
// Tool Executor
// =============================================================================

async function execute(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const {
    generator_id,
    prompt,
    negative_prompt,
    anchor_ids,
    user_image_path,
    input_image_path,
    aspect_ratio,
  } = args as {
    generator_id: string;
    prompt: string;
    negative_prompt?: string;
    anchor_ids?: string[];
    user_image_path?: string;
    input_image_path?: string;
    aspect_ratio?: string;
  };

  const settings = ctx.config.imageGenSettings;
  if (!settings) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: Image generation is not configured. No image generators available.",
      isError: true,
    };
  }

  const generator = settings.generators.find((g) => g.id === generator_id);
  if (!generator) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Error: Generator '${generator_id}' not found. Available generators: ${
          settings.generators.map((g) => g.id).join(", ") || "(none)"
        }`,
      isError: true,
    };
  }

  if (!generator.enabled) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Error: Generator '${generator.name}' (${generator_id}) is disabled.`,
      isError: true,
    };
  }

  const dataRoot = ctx.config.dataRoot;

  const anchorImages: Array<{ data: string; mediaType: string }> = [];
  if (anchor_ids && anchor_ids.length > 0) {
    for (const anchorId of anchor_ids) {
      try {
        const row = ctx.db.getRawDb()
          .prepare("SELECT filename FROM anchor_images WHERE id = ?")
          .get<{ filename: string }>(anchorId);
        if (!row) {
          return {
            toolCallId: ctx.toolCallId,
            content: `Error: Anchor image '${anchorId}' not found in database.`,
            isError: true,
          };
        }
        const filePath = join(
          dataRoot,
          ".psycheros",
          "anchors",
          row.filename,
        );
        const fileData = await Deno.readFile(filePath);
        const base64 = uint8ToBase64(fileData);
        const mediaType = getMediaType(row.filename);
        anchorImages.push({ data: base64, mediaType });
      } catch (error) {
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Failed to read anchor image '${anchorId}': ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        };
      }
    }
  }

  let userImage: { data: string; mediaType: string } | undefined;
  if (user_image_path) {
    try {
      const filePath = join(dataRoot, ".psycheros", user_image_path);
      const fileData = await Deno.readFile(filePath);
      const base64 = uint8ToBase64(fileData);
      const mediaType = getMediaType(user_image_path);
      userImage = { data: base64, mediaType };
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: Failed to read user image '${user_image_path}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  let inputImage: { data: string; mediaType: string } | undefined;
  if (input_image_path) {
    try {
      const filePath = join(dataRoot, ".psycheros", input_image_path);
      const fileData = await Deno.readFile(filePath);
      const base64 = uint8ToBase64(fileData);
      const mediaType = getMediaType(input_image_path);
      inputImage = { data: base64, mediaType };
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: Failed to read input image '${input_image_path}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  try {
    if (aspect_ratio) {
      generator.settings.params.aspect_ratio = aspect_ratio;
    }

    let result: { imageData: string; mediaType: string };

    switch (generator.provider) {
      case "openrouter":
        result = await generateViaOpenRouter(
          generator,
          prompt,
          negative_prompt,
          anchorImages,
          userImage,
          inputImage,
        );
        break;
      case "gemini":
        result = await generateViaGemini(
          generator,
          prompt,
          negative_prompt,
          anchorImages,
          userImage,
          inputImage,
        );
        break;
      case "comfyui":
        return {
          toolCallId: ctx.toolCallId,
          content: "Error: ComfyUI provider is not yet implemented.",
          isError: true,
        };
      case "native":
        return {
          toolCallId: ctx.toolCallId,
          content:
            "Error: Native image generation provider is not yet implemented.",
          isError: true,
        };
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Unknown provider '${generator.provider}'.`,
          isError: true,
        };
    }

    const ext = getExtensionFromMediaType(result.mediaType);
    const filename = `${crypto.randomUUID()}.${ext}`;
    const generatedDir = join(dataRoot, ".psycheros", "generated-images");
    await Deno.mkdir(generatedDir, { recursive: true });
    const filePath = join(generatedDir, filename);
    const imageBytes = Uint8Array.from(
      atob(result.imageData),
      (c) => c.charCodeAt(0),
    );
    await Deno.writeFile(filePath, imageBytes);

    let description: string | undefined;
    let shortDescription: string | undefined;
    const captioningSettings = ctx.config.imageGenSettings?.captioning;
    if (captioningSettings?.provider) {
      try {
        const caption = await captionImageDual(
          result.imageData,
          result.mediaType,
          captioningSettings,
        );
        description = caption.long;
        shortDescription = caption.short;
      } catch (captionError) {
        console.error("[ImageGen] Auto-captioning failed:", captionError);
      }
    }

    const imagePath = `/generated-images/${filename}`;
    const markerData: Record<string, string> = {
      path: imagePath,
      prompt,
      generator: generator.name,
    };
    if (description) {
      markerData.description = description;
    }
    if (shortDescription) {
      markerData.shortDescription = shortDescription;
    }
    const marker = JSON.stringify(markerData);

    let resultText = "[image_generated] Image generated successfully.";
    if (description) resultText += ` ${description}`;
    if (shortDescription) resultText += `[short:${shortDescription}]`;
    resultText += ` [IMAGE:${marker}]`;
    return {
      toolCallId: ctx.toolCallId,
      content: resultText,
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Error generating image: ${
        error instanceof Error ? error.message : String(error)
      }`,
      isError: true,
    };
  }
}

// =============================================================================
// Helpers (exported for reuse by captioning)
// =============================================================================

export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E\x80-\xFF]/g, "");
}

export function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function getMediaType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function getExtensionFromMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}
