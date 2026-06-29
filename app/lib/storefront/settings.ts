// app/lib/storefront/settings.ts
// Brand chrome for the storefront shell. Shadows the eventual store_settings_dim
// table (master spec §#7); hard-coded demo brand for now, no migration.
export interface StoreSettings {
  shopId: string;
  storeName: string;
  logoUrl: string; // hotlinked for now
  palette: { primary: string; background: string; text: string };
}

export function getStoreSettings(shopId: string): StoreSettings {
  return {
    shopId,
    storeName: "Calderyn Demo Store",
    logoUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff",
    palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
  };
}
