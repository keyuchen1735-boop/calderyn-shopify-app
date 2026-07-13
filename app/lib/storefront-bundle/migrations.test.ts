import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      `../../../supabase/migrations/${name}`,
    ),
    "utf8",
  ).toLowerCase();

const RELEASES = migration("20260713140000_storefront_bundle_releases.sql");
const ASSETS = migration("20260713141000_storefront_bundle_assets.sql");
const FUNCTIONS = migration("20260713142000_storefront_bundle_functions.sql");
const SQL = `${RELEASES}\n${ASSETS}\n${FUNCTIONS}`;

describe("storefront bundle persistence migrations", () => {
  it("creates the complete release, asset, and edit-audit model with RLS and browser-role revokes", () => {
    for (const table of [
      "storefront_bundle_version",
      "storefront_release",
      "storefront_release_history",
      "storefront_asset_object",
      "storefront_bundle_asset",
      "storefront_bundle_edit",
    ]) {
      expect(SQL).toMatch(new RegExp(`create table public\\.${table}\\b`));
      expect(SQL).toMatch(new RegExp(`alter table public\\.${table} enable row level security`));
      expect(SQL).toMatch(new RegExp(`revoke all on (table )?public\\.${table} from anon, authenticated`));
    }
  });

  it("enforces source, status, runtime/profile, immutable validation, and same-shop foreign keys", () => {
    expect(RELEASES).toMatch(/source_kind[^;]+check[^;]+legacy[^;]+recipe[^;]+custom/);
    expect(RELEASES).toMatch(/status[^;]+check[^;]+candidate[^;]+validated[^;]+failed/);
    expect(RELEASES).toMatch(/source_kind = 'legacy'[^;]+runtime_version = 0[^;]+validation_profile_version = 0/);
    expect(RELEASES).toMatch(/source_kind in \('recipe', 'custom'\)[^;]+runtime_version >= 1[^;]+validation_profile_version >= 1/);
    expect(RELEASES).toMatch(/unique \(shop_id, id\)/);
    expect(RELEASES).toMatch(/foreign key \(shop_id, draft_version_id\)[^;]+references public\.storefront_bundle_version \(shop_id, id\)/);
    expect(RELEASES).toMatch(/foreign key \(shop_id, published_version_id\)[^;]+references public\.storefront_bundle_version \(shop_id, id\)/);
    expect(RELEASES).toMatch(/create trigger storefront_bundle_version_immutable/);
    expect(RELEASES).toMatch(/old\.status = 'validated'/);
  });

  it("defines service-role-only transactional RPCs and explicit stale-pointer conflicts", () => {
    for (const fn of [
      "create_storefront_bundle_version",
      "validate_storefront_bundle_version",
      "capture_storefront_legacy_release",
      "install_storefront_draft",
      "edit_storefront_draft",
      "publish_storefront_release",
      "rollback_storefront_release",
    ]) {
      expect(FUNCTIONS).toMatch(new RegExp(`create (or replace )?function public\\.${fn}\\b`));
      expect(FUNCTIONS).toMatch(new RegExp(`revoke all on function public\\.${fn}[^;]+from public, anon, authenticated`));
      expect(FUNCTIONS).toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]+to service_role`));
    }
    expect(FUNCTIONS).toMatch(/get diagnostics[^;]+row_count/);
    expect(FUNCTIONS).toMatch(/storefront_(draft|publish|rollback)_conflict/);
    expect(FUNCTIONS).toMatch(/for update/);
  });

  it("validates exact asset manifests and implements lock plus generation-safe tombstone GC", () => {
    expect(FUNCTIONS).toMatch(/jsonb_array_length/);
    expect(FUNCTIONS).toMatch(/asset_manifest_mismatch/);
    expect(FUNCTIONS).toMatch(/status = 'locked'/);
    expect(ASSETS).toMatch(/state[^;]+staged[^;]+verified[^;]+deleting[^;]+deleted[^;]+failed/);
    expect(FUNCTIONS).toMatch(/generation = generation \+ 1/);
    expect(FUNCTIONS).toMatch(/state = 'deleting'/);
    expect(FUNCTIONS).toMatch(/p_expected_generation/);
    expect(FUNCTIONS).toMatch(/not exists[^;]+storefront_bundle_asset/);
  });

  it("captures legacy once, stores replayable edit metadata, and rejects running experiments", () => {
    expect(FUNCTIONS).toMatch(/legacy_capture/);
    expect(FUNCTIONS).toMatch(/runtime_version[^;]+0/);
    expect(FUNCTIONS).toMatch(/where source_kind = 'legacy'/);
    expect(FUNCTIONS).toMatch(/'sha256:' \|\| encode\(sha256/);
    expect(FUNCTIONS).toMatch(/from public\.asset_dim/);
    expect(FUNCTIONS).toMatch(/insert into public\.storefront_bundle_edit/);
    for (const field of ["base_artifact_hash", "result_artifact_hash", "prompt", "scope_json", "patch_json", "provider_json", "validation_json"]) {
      expect(RELEASES).toContain(field);
    }
    expect(FUNCTIONS).toMatch(/storefront_experiment_running/);
    expect(FUNCTIONS).toMatch(/from public\.store_experiment[^;]+state = 'running'/);
  });

  it("serializes bundle and legacy-experiment transitions through one shop lock", () => {
    expect(FUNCTIONS).toMatch(/create (or replace )?function public\.lock_storefront_design_shop/);
    expect(FUNCTIONS).toMatch(/pg_advisory_xact_lock/);
    for (const fn of [
      "create_storefront_bundle_version",
      "capture_storefront_legacy_release",
      "install_storefront_draft",
      "edit_storefront_draft",
      "publish_storefront_release",
      "rollback_storefront_release",
      "start_store_experiment",
      "transition_store_experiment",
    ]) {
      const body = FUNCTIONS.match(new RegExp(`function public\\.${fn}[\\s\\S]+?\\$\\$;`))?.[0] ?? "";
      expect(body).toContain("lock_storefront_design_shop");
    }
  });

  it("recomputes canonical hashes and reserves legacy creation for validated capture", () => {
    expect(FUNCTIONS).toMatch(/create (or replace )?function public\.storefront_artifact_hash/);
    expect(FUNCTIONS).toMatch(/storefront_artifact_hash_mismatch/);
    expect(FUNCTIONS).toMatch(/legacy_source_requires_capture/);
    expect(FUNCTIONS).toMatch(/legacy_adapter[^;]+validated/);
  });

  it("protects validated versions, locked references, and retained release targets from deletion", () => {
    expect(SQL).toMatch(/validated_storefront_bundle_is_immutable/);
    expect(SQL).toMatch(/tg_op = 'delete'/);
    expect(SQL).toMatch(/locked_storefront_bundle_asset_is_immutable/);
    expect(SQL).toMatch(/storefront_bundle_asset_locked_guard/);
    expect(SQL).toMatch(/on delete restrict/);
  });

  it("derives immutable asset keys and verifies deletion generation immediately before removal", () => {
    expect(FUNCTIONS).toMatch(/storefront_asset_key/);
    expect(FUNCTIONS).toMatch(/storefront_asset_key_mismatch/);
    expect(FUNCTIONS).toMatch(/verify_storefront_asset_gc/);
  });
});
