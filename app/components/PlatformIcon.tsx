type PlatformName = "Meta" | "Google" | "TikTok" | string;

type Props = {
  platform: PlatformName;
  size?: number;
  title?: string;
};

/** Favicons downloaded directly from each platform's official website. */
const PLATFORM_FAVICONS: Record<string, string> = {
  meta: "/brand-platforms/meta.svg",
  facebook: "/brand-platforms/facebook.ico",
  instagram: "/brand-platforms/instagram.webp",
  google: "/brand-platforms/google.png",
  "google ads": "/brand-platforms/google.png",
  tiktok: "/brand-platforms/tiktok.ico",
  "tik tok": "/brand-platforms/tiktok.ico",
};

export function PlatformIcon({ platform, size = 16, title }: Props) {
  const label = title ?? platform;
  const src = PLATFORM_FAVICONS[platform.trim().toLowerCase()];

  if (src) {
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
      />
    );
  }

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
    </svg>
  );
}
