import type { CampaignVM } from "../view-models";

/**
 * Honest empty-state copy for a campaign's Creative panel, chosen by cause.
 *
 * Live creative preview is Meta-only — Meta is the only platform with a creative
 * fetcher — so the "Connect Meta" prompt must never surface on a Google/TikTok
 * campaign. Those report that preview isn't available for their platform yet
 * rather than pointing the merchant at an unrelated integration.
 */
export function creativeEmptyText(
  platform: CampaignVM["platform"],
  args: { loadError: boolean; data: { metaConnected: boolean } | null },
): string {
  if (args.loadError) return "Couldn't load the creative — refresh to retry";
  if (!args.data) return "Loading creative…";
  if (platform !== "Meta") {
    return `Creative preview isn't available for ${platform} campaigns yet`;
  }
  if (!args.data.metaConnected) return "Connect Meta to see this campaign's creative";
  return "No creative yet";
}
