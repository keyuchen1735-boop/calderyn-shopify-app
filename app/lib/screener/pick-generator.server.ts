// app/lib/screener/pick-generator.server.ts
// Select a CreativeGenerator by requested mode. Lives in a .server module (not the
// route) because it pulls in server-only generator factories — exporting it from
// the route would leak server code into the client bundle.
import { copyGenerator, type CreateMessageFn, type CreativeGenerator } from "./generate.server";
import { geminiImageClient, imageGenerator } from "./image-generator.server";

/** Image gen requires Gemini credentials; any non-"image"
 *  mode uses the always-on copy generator. */
export function pickGenerator(
  mode: string | null,
  deps: {
    createMessage: CreateMessageFn;
    model: string;
    image?: {
      shopId: string;
      purpose: "campaign_initial" | "campaign_regeneration";
      generationId: string;
    };
  },
): CreativeGenerator {
  if (mode === "image") {
    if (!deps.image) throw new Error("Image generation context is required");
    return imageGenerator({ generateImage: geminiImageClient(deps.image) });
  }
  return copyGenerator({ createMessage: deps.createMessage, model: deps.model });
}
