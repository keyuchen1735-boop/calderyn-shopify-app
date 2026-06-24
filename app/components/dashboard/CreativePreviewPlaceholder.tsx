import type { CSSProperties } from "react";
import { CDIcon } from "./icons";

export default function CreativePreviewPlaceholder({
  label,
  style,
}: {
  label: string;
  style?: CSSProperties;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minWidth: 0,
        overflow: "hidden",
        borderRadius: 12,
        background: "var(--surface-2, #f3f4f6)",
        color: "var(--text-3, #6b7280)",
        textAlign: "center",
        fontSize: 12,
        padding: 12,
        ...style,
      }}
    >
      <CDIcon name="doc" size={22} strokeWidth={1.7} />
      <span>{label}</span>
    </div>
  );
}
