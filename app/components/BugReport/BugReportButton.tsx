import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  DropZone,
  InlineStack,
  Modal,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type ActionData = { ok?: boolean; emailStatus?: string; error?: { code: string; message: string } };
// File plus its preview object URL, created once on drop and revoked on removal —
// never in render, so typing in the form doesn't leak a new blob URL per keystroke.
type Item = { file: File; url: string };

export function BugReportButton() {
  const shopify = useAppBridge();
  const fetcher = useFetcher<ActionData>();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const handledRef = useRef(false);

  const submitting = fetcher.state !== "idle";

  // Close + toast once per successful submit, then clear the form. Setters are
  // inlined (not a `reset()` closure) to keep this effect's deps honest.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && !handledRef.current) {
      handledRef.current = true;
      setOpen(false);
      setDescription("");
      setEmail("");
      setItems((prev) => {
        prev.forEach((it) => window.URL.revokeObjectURL(it.url));
        return [];
      });
      setFileError(null);
      shopify.toast.show("Thanks — your bug report was sent.");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const onDrop = useCallback((_dropped: File[], accepted: File[], _rejected: File[]) => {
    setFileError(null);
    const next: File[] = [];
    for (const f of accepted) {
      if (!ALLOWED.includes(f.type)) {
        setFileError("Only PNG, JPG, GIF, or WebP images.");
        continue;
      }
      if (f.size > MAX_BYTES) {
        setFileError("Each image must be 5 MB or smaller.");
        continue;
      }
      next.push(f);
    }
    setItems((prev) => {
      const room = Math.max(0, MAX_FILES - prev.length);
      if (next.length > room) setFileError(`You can attach at most ${MAX_FILES} images.`);
      const added = next.slice(0, room).map((file) => ({ file, url: window.URL.createObjectURL(file) }));
      return [...prev, ...added];
    });
  }, []);

  const removeFile = (idx: number) =>
    setItems((prev) => {
      const target = prev[idx];
      if (target) window.URL.revokeObjectURL(target.url);
      return prev.filter((_, i) => i !== idx);
    });

  const submit = () => {
    handledRef.current = false;
    const fd = new FormData();
    fd.set("description", description);
    fd.set("email", email);
    fd.set("screen", typeof window !== "undefined" ? window.location.pathname : "");
    for (const it of items) fd.append("screenshots", it.file, it.file.name);
    fetcher.submit(fd, { method: "post", action: "/app/bug-report", encType: "multipart/form-data" });
  };

  const actionError = fetcher.data?.error?.message;
  const canSubmit = description.trim().length > 0 && email.trim().length > 0 && !submitting;

  return (
    <>
      <div className="calderyn-bugreport-launcher">
        <Button onClick={() => setOpen(true)}>Report a bug</Button>
      </div>
      <Modal
        open={open}
        onClose={() => {
          if (!submitting) setOpen(false);
        }}
        title="Report a bug"
        primaryAction={{ content: "Send report", onAction: submit, loading: submitting, disabled: !canSubmit }}
        secondaryActions={[{ content: "Cancel", onAction: () => setOpen(false), disabled: submitting }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {actionError && <Banner tone="critical">{actionError}</Banner>}
            <TextField
              label="What went wrong?"
              value={description}
              onChange={setDescription}
              multiline={4}
              autoComplete="off"
              maxLength={5000}
              placeholder="Tell us what happened and what you expected."
            />
            <TextField
              label="Your email (so we can follow up)"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              placeholder="you@store.com"
            />
            <BlockStack gap="200">
              <Text as="span" variant="bodyMd">
                Screenshots (optional)
              </Text>
              <DropZone accept="image/*" type="image" onDrop={onDrop} allowMultiple>
                <DropZone.FileUpload
                  actionTitle="Add images"
                  actionHint="PNG, JPG, GIF or WebP — up to 5 MB each, 3 max"
                />
              </DropZone>
              {fileError && (
                <Text as="span" tone="critical" variant="bodySm">
                  {fileError}
                </Text>
              )}
              {items.length > 0 && (
                <InlineStack gap="200">
                  {items.map((it, i) => (
                    <InlineStack key={it.url} gap="100" blockAlign="center">
                      <Thumbnail size="small" alt={it.file.name} source={it.url} />
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeFile(i)}
                        accessibilityLabel={`Remove ${it.file.name}`}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                  ))}
                </InlineStack>
              )}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}
