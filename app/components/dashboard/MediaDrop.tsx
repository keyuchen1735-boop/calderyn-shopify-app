import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  MEDIA_ACCEPT,
  processCreativeMedia,
  type ProcessedCreativeMedia,
} from "~/lib/creative-media";

export default function MediaDrop({
  value,
  onChange,
  disabled,
}: {
  value: ProcessedCreativeMedia | null;
  onChange: (media: ProcessedCreativeMedia | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ingest = async (file: File | null | undefined) => {
    if (!file || disabled || busy) return;
    setError(null);
    setBusy(true);
    try {
      onChange(await processCreativeMedia(file));
    } catch (err) {
      onChange(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void ingest(e.dataTransfer?.files?.[0]);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  return (
    <div className="cd-field">
      <span>Ad creative (required)</span>
      <div
        className={`cd-mediadrop${over ? " is-over" : ""}${disabled ? " is-disabled" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Add the ad's image or video"
        onClick={() => inputRef.current?.click()}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {value ? (
          <>
            <img className="cd-mediadrop-thumb" src={value.imageUrl} alt="Creative preview" />
            <div className="cd-mediadrop-meta">
              <b>
                {value.kind === "video"
                  ? `Video · ~${Math.round(value.durationSec)}s · ${value.frameUrls.length} key frame${value.frameUrls.length === 1 ? "" : "s"}`
                  : "Image ready to score"}
              </b>
              <span>Drop a new file to replace it.</span>
            </div>
          </>
        ) : busy ? (
          <div className="cd-mediadrop-meta">
            <span className="cd-spinner"></span>
            <span>Reading your creative…</span>
          </div>
        ) : (
          <div className="cd-mediadrop-meta">
            <b>Drop the actual ad — image or video</b>
            <span>
              PNG, JPEG, WebP, AVIF · MP4, WebM, MOV · or <u>browse files</u>
            </span>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={MEDIA_ACCEPT}
          hidden
          onChange={(e) => {
            void ingest(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="cd-mediadrop-err">{error}</p>}
    </div>
  );
}
