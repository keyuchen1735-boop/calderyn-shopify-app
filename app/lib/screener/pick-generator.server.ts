// app/lib/screener/pick-generator.server.ts
// Select a CreativeGenerator by requested mode. Lives in a .server module (not the
// route) because it pulls in server-only generator factories — exporting it from
// the route would leak server code into the client bundle.
import { copyGenerator, type CreateMessageFn, type CreativeGenerator } from "./generate.server";
import { imageGenerator, higgsfieldImageClient } from "./higgsfield.server";

/** Image gen requires Higgsfield creds (gated by its available()); any non-"image"
 *  mode uses the always-on copy generator. */
export function pickGenerator(
  mode: string | null,
  deps: { createMessage: CreateMessageFn; model: string },
): CreativeGenerator {
  if (mode === "image") {
    return imageGenerator({ generateImage: higgsfieldImageClient() });
  }
  return copyGenerator({ createMessage: deps.createMessage, model: deps.model });
}
