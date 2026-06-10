import type { CSSProperties } from "react";

type PlatformName = "Meta" | "Google" | "TikTok" | string;

type Props = {
  platform: PlatformName;
  size?: number;
  title?: string;
};

const svgStyle: CSSProperties = { display: "block", flexShrink: 0 };

export function PlatformIcon({ platform, size = 16, title }: Props) {
  const label = title ?? platform;
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    role: "img" as const,
    "aria-label": label,
    style: svgStyle,
  };

  switch (platform) {
    case "Meta":
      // Facebook "f" mark in Meta blue — Meta Ads ships from Facebook/Instagram
      // surfaces, and the "f" is the most instantly-recognised glyph in the family.
      return (
        <svg {...common}>
          <title>{label}</title>
          <path
            fill="#1877F2"
            d="M24 12c0-6.627-5.373-12-12-12S0 5.373 0 12c0 5.99 4.388 10.954 10.125 11.854V15.469H7.078V12h3.047V9.356c0-3.007 1.792-4.668 4.533-4.668 1.313 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874V12h3.328l-.532 3.469h-2.796v8.385C19.612 22.954 24 17.99 24 12z"
          />
        </svg>
      );
    case "Google":
      // Multi-colour Google "G"
      return (
        <svg {...common}>
          <title>{label}</title>
          <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.51h6.47c-.28 1.48-1.12 2.73-2.39 3.57v2.96h3.86c2.26-2.08 3.55-5.15 3.55-8.77z" />
          <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.94-2.91l-3.86-2.96c-1.07.72-2.45 1.15-4.08 1.15-3.13 0-5.79-2.11-6.74-4.95H1.27v3.06A12 12 0 0 0 12 24z" />
          <path fill="#FBBC05" d="M5.26 14.33A7.2 7.2 0 0 1 4.88 12c0-.81.14-1.6.38-2.33V6.61H1.27A12 12 0 0 0 0 12c0 1.93.46 3.76 1.27 5.39l3.99-3.06z" />
          <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.61l3.99 3.06C6.21 6.86 8.87 4.75 12 4.75z" />
        </svg>
      );
    case "TikTok":
      // TikTok musical note — uses currentColor so it stays legible in both the
      // light and dark dashboard themes (parent sets the resolved text colour).
      // The cyan/magenta brand-stack version is too noisy at 16px.
      return (
        <svg {...common}>
          <title>{label}</title>
          <path
            fill="currentColor"
            d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"
          />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <title>{label}</title>
          <circle cx="12" cy="12" r="9" fill="#C9C9C9" />
        </svg>
      );
  }
}
