// Renders a PUBLISHED designer page bare (the storefront layout skips its
// chrome for these — the document carries its own header and footer). The
// body html was scrubbed server-side; the only script is the runtime-owned
// cart wiring, allowed by the page's CSP nonce.
import type { DesignerPublicPage } from "~/lib/designer/types";

export default function DesignerPublicView({ page }: { page: DesignerPublicPage }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: page.css }} />
      <div dangerouslySetInnerHTML={{ __html: page.bodyHtml }} />
      <script nonce={page.nonce} dangerouslySetInnerHTML={{ __html: page.cartScript }} />
    </>
  );
}
