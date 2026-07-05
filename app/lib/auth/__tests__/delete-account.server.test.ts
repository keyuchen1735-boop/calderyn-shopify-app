import { describe, it, expect, vi, beforeEach } from "vitest";

// membership.select().eq() resolves to the member rows; users/shops delete().eq()
// resolve to { error }. Each is a fresh spy so tests assert exactly what ran.
const membershipEq = vi.fn();
const usersDeleteEq = vi.fn().mockResolvedValue({ error: null });
const shopsDeleteEq = vi.fn().mockResolvedValue({ error: null });

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "membership") {
        return { select: () => ({ eq: membershipEq }) };
      }
      if (table === "users") {
        return { delete: () => ({ eq: usersDeleteEq }) };
      }
      // shops
      return { delete: () => ({ eq: shopsDeleteEq }) };
    },
  }),
}));

beforeEach(() => {
  membershipEq.mockReset();
  usersDeleteEq.mockReset().mockResolvedValue({ error: null });
  shopsDeleteEq.mockReset().mockResolvedValue({ error: null });
});

describe("deleteAccount", () => {
  it("sole member: deletes the user then the shop, and reports shopDeleted", async () => {
    membershipEq.mockResolvedValue({ data: [{ user_id: "u1" }], error: null });
    const { deleteAccount } = await import("../delete-account.server");

    const res = await deleteAccount("u1", "shop1");

    expect(res.shopDeleted).toBe(true);
    expect(usersDeleteEq).toHaveBeenCalledWith("id", "u1");
    expect(shopsDeleteEq).toHaveBeenCalledWith("id", "shop1");
  });

  it("empty membership read: fails safe — deletes the user but leaves the shop", async () => {
    membershipEq.mockResolvedValue({ data: [], error: null });
    const { deleteAccount } = await import("../delete-account.server");

    const res = await deleteAccount("u1", "shop1");

    expect(res.shopDeleted).toBe(false);
    expect(usersDeleteEq).toHaveBeenCalledWith("id", "u1");
    expect(shopsDeleteEq).not.toHaveBeenCalled();
  });

  it("co-owned shop: deletes only the user, leaves the shop", async () => {
    membershipEq.mockResolvedValue({
      data: [{ user_id: "u1" }, { user_id: "u2" }],
      error: null,
    });
    const { deleteAccount } = await import("../delete-account.server");

    const res = await deleteAccount("u1", "shop1");

    expect(res.shopDeleted).toBe(false);
    expect(usersDeleteEq).toHaveBeenCalledWith("id", "u1");
    expect(shopsDeleteEq).not.toHaveBeenCalled();
  });

  it("deletes the user before the shop so a failed teardown still frees the email", async () => {
    membershipEq.mockResolvedValue({ data: [{ user_id: "u1" }], error: null });
    const order: string[] = [];
    usersDeleteEq.mockImplementation(() => {
      order.push("user");
      return Promise.resolve({ error: null });
    });
    shopsDeleteEq.mockImplementation(() => {
      order.push("shop");
      return Promise.resolve({ error: null });
    });
    const { deleteAccount } = await import("../delete-account.server");

    await deleteAccount("u1", "shop1");

    expect(order).toEqual(["user", "shop"]);
  });

  it("propagates a membership read error without deleting anything", async () => {
    membershipEq.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { deleteAccount } = await import("../delete-account.server");

    await expect(deleteAccount("u1", "shop1")).rejects.toMatchObject({ message: "boom" });
    expect(usersDeleteEq).not.toHaveBeenCalled();
    expect(shopsDeleteEq).not.toHaveBeenCalled();
  });

  it("propagates a user delete error before touching the shop", async () => {
    membershipEq.mockResolvedValue({ data: [{ user_id: "u1" }], error: null });
    usersDeleteEq.mockResolvedValue({ error: { message: "user delete failed" } });
    const { deleteAccount } = await import("../delete-account.server");

    await expect(deleteAccount("u1", "shop1")).rejects.toMatchObject({
      message: "user delete failed",
    });
    expect(shopsDeleteEq).not.toHaveBeenCalled();
  });
});
