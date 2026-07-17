import { useState } from "react";

type PlatformName = "Meta" | "Google" | "TikTok" | string;

type Props = {
  platform: PlatformName;
  size?: number;
  title?: string;
};

/**
 * Official platform marks, served from short neutral paths: content blockers
 * drop image requests whose URL contains a platform name, which left these
 * icons blank for users running one.
 */
const PLATFORM_FAVICONS: Record<string, string> = {
  meta: "/pf/m.svg",
  facebook: "/pf/f.ico",
  instagram: "/pf/i.webp",
  google: "/pf/g.png",
  "google ads": "/pf/g.png",
  tiktok: "/pf/t.ico",
  "tik tok": "/pf/t.ico",
};

function FallbackMark({ label, size }: { label: string; size: number }) {
  const initial = label.trim().charAt(0).toUpperCase();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      style={{ display: "block", flexShrink: 0 }}
    >
      <title>{label}</title>
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.28" />
      {initial ? (
        <text
          x="12"
          y="16"
          textAnchor="middle"
          fontSize="10"
          fontWeight="650"
          fill="currentColor"
        >
          {initial}
        </text>
      ) : null}
    </svg>
  );
}

export function PlatformIcon({ platform, size = 16, title }: Props) {
  const label = title ?? platform;
  const src = PLATFORM_FAVICONS[platform.trim().toLowerCase()];
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt={label}
        title={title}
        draggable={false}
        className="cd-platform-favicon"
        style={{ display: "block", flexShrink: 0, objectFit: "contain" }}
        onError={() => setFailed(true)}
      />
    );
  }

  return <FallbackMark label={label} size={size} />;
}
