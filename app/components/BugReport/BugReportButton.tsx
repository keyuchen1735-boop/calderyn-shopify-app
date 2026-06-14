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

export function BugReportButton() {
  const shopify = useAppBridge();
  const fetcher = useFetcher<ActionData>();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const handledRef = useRef(false);

  const submitting = fetcher.state !== "idle";

  const reset = () => {
    setDescription("");
    setEmail("");
    setFiles([]);
    setFileError(null);
  };

  // Close + toast once per successful submit.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && !handledRef.current) {
      handledRef.current = true;
      setOpen(false);
      reset();
      shopify.toast.show("Thanks — your bug report was sent.");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const onDrop = useCallback((_dropped: File[], accepted: File[], rejected: File[]) => {
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
    if (rejected.length) setFileError("Only PNG, JPG, GIF, or WebP images.");
    setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES));
  }, []);

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const submit = () => {
    handledRef.current = false;
    const fd = new FormData();
    fd.set("description", description);
    fd.set("email", email);
    fd.set("screen", typeof window !== "undefined" ? window.location.pathname : "");
    for (const f of files) fd.append("screenshots", f, f.name);
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
              {files.length > 0 && (
                <InlineStack gap="200">
                  {files.map((f, i) => (
                    <InlineStack key={`${f.name}-${i}`} gap="100" blockAlign="center">
                      <Thumbnail size="small" alt={f.name} source={window.URL.createObjectURL(f)} />
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeFile(i)}
                        accessibilityLabel={`Remove ${f.name}`}
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
