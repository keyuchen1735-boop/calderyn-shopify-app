import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.order-reaper";

const abandonReaper = vi.hoisted(() => ({
  reapAbandonedCheckouts: vi.fn(async () => ({
    scanned: 3,
    cancelled: 2,
    skippedPaidRace: 1,
    failed: 0,
  })),
}));
vi.mock("../../lib/order/abandon-reaper.server", () => ({
  reapAbandonedCheckouts: abandonReaper.reapAbandonedCheckouts,
}));

const recovery = vi.hoisted(() => ({
  autoSendRecoveryEmails: vi.fn(async () => ({ sent: 5, skipped: 1 })),
}));
vi.mock("../../lib/order/recovery.server", () => ({
  autoSendRecoveryEmails: recovery.autoSendRecoveryEmails,
}));

const req = (auth?: string) =>
  new Request("https://app.test/cron/order-reaper", {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
});

describe("cron.order-reaper loader", () => {
  it("401s without a bearer secret", async () => {
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    expect(abandonReaper.reapAbandonedCheckouts).not.toHaveBeenCalled();
    expect(recovery.autoSendRecoveryEmails).not.toHaveBeenCalled();
  });

  it("401s with the wrong bearer secret", async () => {
    const res = await loader({ request: req("Bearer wrong"), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    expect(abandonReaper.reapAbandonedCheckouts).not.toHaveBeenCalled();
    expect(recovery.autoSendRecoveryEmails).not.toHaveBeenCalled();
  });

  it("200s with the reaper's + recovery sweep's JSON counts when the bearer secret is correct", async () => {
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      scanned: 3,
      cancelled: 2,
      skippedPaidRace: 1,
      failed: 0,
      recovery: { sent: 5, skipped: 1 },
    });
    expect(abandonReaper.reapAbandonedCheckouts).toHaveBeenCalledTimes(1);
    expect(recovery.autoSendRecoveryEmails).toHaveBeenCalledTimes(1);
  });

  it("runs the recovery sweep BEFORE reaping, and never lets a recovery failure block the reap", async () => {
    recovery.autoSendRecoveryEmails.mockRejectedValueOnce(new Error("boom"));
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      scanned: 3,
      cancelled: 2,
      skippedPaidRace: 1,
      failed: 0,
      recovery: { sent: 0, skipped: 0 },
    });
    expect(abandonReaper.reapAbandonedCheckouts).toHaveBeenCalledTimes(1);
  });
});
