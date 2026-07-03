import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Card,
  AreaChart,
  Btn,
  GradePill,
  CountMoney,
  CountNum,
  Segmented,
  Placeholder,
} from "../ui";
import { fetchAnalytics, DashboardApiError } from "~/lib/dashboard/client";
import { gradeFromRow } from "~/lib/campaign-grade";
import type { DashboardCtx } from "../context";
import type { DailyRow, TopAd } from "../view-models";
import type { CampaignGradeRow } from "~/lib/types";
import {
  StatRow,
  FocusCard,
  ActivityFeed,
  GuardrailCard,
  AttentionSection,
} from "./overview-cards";
import { PeerBenchmarks } from "./PeerBenchmarks";
import AnalyticsLive from "./AnalyticsLive";
import type { PeerBenchmarks as BenchmarksData } from "~/lib/benchmarks/types";

type Range = "7d" | "14d" | "30d";

interface AnalyticsData {
  daily: DailyRow[];
  grades: CampaignGradeRow[];
  topAds: TopAd[];
}

/* ---------- Header ---------- */
function ScreenHeader({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2.5">{children}</div>}
    </header>
  );
}

export default function Analytics({ app }: { app: DashboardCtx }) {
  const [range, setRange] = useState<Range>("30d");
  // Performance ↔ Live rides the URL (/dashboard/analytics vs /analytics/live)
  // so both subtabs are deep-linkable and back-button friendly.
  const view: "performance" | "live" = app.nav.sub === "live" ? "live" : "performance";
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Peer Benchmarks: self-fetched (relocated from the former Overview).
  const [benchmarks, setBenchmarks] = useState<BenchmarksData | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchAnalytics()
      .then((res) => {
        if (!alive) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(
          err instanceof DashboardApiError ? err.message : "Couldn't load analytics.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/dashboard/api/benchmarks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray((d as BenchmarksData).kpis)) {
          setBenchmarks(d as BenchmarksData);
        }
      })
      .catch((e) => {
        console.error("peer benchmarks fetch failed", e);
      });
    return () => {
      alive = false;
    };
  }, []);

  // The daily series arrives with daysAgo offsets (0 = today). Slice the most
  // recent N days for the selected range — i.e. the rows with the smallest
  // daysAgo. Preserve oldest→newest order for the chart.
  const rows = useMemo<DailyRow[]>(() => {
    const all = data?.daily ?? [];
    if (range === "30d") return all;
    const n = range === "7d" ? 7 : 14;
    return all.slice(-n);
  }, [data, range]);

  const spend = rows.reduce((s, r) => s + r.spend_cents, 0);
  const revenue = rows.reduce((s, r) => s + r.revenue_cents, 0);
  const blended = spend > 0 ? revenue / spend : 0;

  const grades = data?.grades ?? [];
  const winning = grades.filter((g) => g.grade === "winning");
  const losing = grades.filter((g) => g.break_even_roas > 0 && g.roas < g.break_even_roas);

  const topAds = data?.topAds ?? [];
  const maxEng = topAds.length ? Math.max(...topAds.map((a) => a.engagement)) : 1;
  // Scale for the campaign grade bars — top of the track maps to the best ROAS
  // seen (with headroom), so the fill never overflows when ROAS is high.
  const gradeMax = grades.length
    ? Math.max(6.5, ...grades.map((g) => g.roas), ...grades.map((g) => g.break_even_roas)) * 1.05
    : 6.5;

  // The Performance ↔ Live subtab switch, present in every header state so the
  // Live view stays reachable while Performance is still loading or errored.
  // The Agentic channel rides along here — it lost its top-level nav item in
  // the grouped IA, and this is its home surface now.
  const viewSwitch = (
    <>
      <Segmented
        small
        value={view}
        onChange={(v) => app.navigate("analytics", null, v === "live" ? "live" : "perf")}
        options={[
          { value: "performance", label: "Performance" },
          { value: "live", label: "Live" },
        ]}
      />
      <Btn small icon="bot" onClick={() => app.navigate("agentic")}>
        Agentic channel
      </Btn>
    </>
  );

  // The Live subtab is fully independent of the performance fetch — bail out
  // before the loading/error states so those never leak into (or block) it.
  if (view === "live") {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Analytics" sub="Your storefront right now.">
          {viewSwitch}
        </ScreenHeader>
        <AnalyticsLive />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Analytics" sub="Loading blended performance across your ad accounts…">
          {viewSwitch}
        </ScreenHeader>
        <Card pad={false}>
          <Placeholder icon="chart" title="Loading analytics" sub="Reading spend, revenue and campaign grades." />
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Analytics">{viewSwitch}</ScreenHeader>
        <Card pad={false}>
          <Placeholder icon="warn" title="Couldn't load analytics" sub={error} />
        </Card>
      </div>
    );
  }

  const haveDaily = rows.length > 1;

  return (
    <div className="cd-screen">
      <ScreenHeader title="Analytics" sub="Blended performance across Meta, Google and TikTok — margin-aware.">
        {viewSwitch}
        <Segmented
          small
          value={range}
          onChange={(v) => setRange(v as Range)}
          options={["7d", "14d", "30d"]}
        />
      </ScreenHeader>

      <div className="cd-stat-grid">
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Ad spend ({range})</span>
          <span className="cd-stat-value">
            <CountMoney cents={spend} />
          </span>
          <span className="cd-caption">across {grades.length} graded campaigns</span>
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Attributed revenue</span>
          <span className="cd-stat-value">
            <CountMoney cents={revenue} />
          </span>
          <span className="cd-caption">last-click + modeled</span>
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Blended ROAS</span>
          <span
            className="cd-stat-value tabular-nums"
            style={{ color: blended >= 2 ? "var(--green)" : "var(--orange)" }}
          >
            <CountNum value={blended} decimals={1} suffix="×" />
          </span>
          <span className="cd-caption">revenue ÷ spend, blended</span>
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Campaign health</span>
          <span className="cd-stat-value tabular-nums">
            {winning.length}
            <span style={{ color: "var(--text-3)", fontWeight: 500 }}>/{grades.length}</span>
          </span>
          <span className="cd-caption" style={losing.length ? { color: "var(--red)" } : undefined}>
            {losing.length ? `${losing.length} below break-even` : "all above break-even"}
          </span>
        </Card>
      </div>

      <Card pad={false}>
        <div className="cd-pad-x cd-pad-t flex items-center justify-between">
          <h2 className="cd-h2">Revenue vs ad spend</h2>
          <div className="flex items-center gap-4">
            <span className="cd-caption flex items-center gap-1.5">
              <span className="cd-dot" style={{ background: "var(--accent)" }}></span>Revenue
            </span>
            <span className="cd-caption flex items-center gap-1.5">
              <span className="cd-dot" style={{ background: "var(--text-3)" }}></span>Ad spend
            </span>
          </div>
        </div>
        <div className="cd-pad" style={{ paddingTop: 8 }}>
          {haveDaily ? (
            <AreaChart rows={rows} height={260} live={app.liveOn} />
          ) : (
            <Placeholder icon="chart" title="No data yet" sub="Spend and revenue will chart here once your ad accounts report a few days of activity." />
          )}
        </div>
      </Card>

      <div className="cd-grid-main">
        <section className="min-w-0">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="cd-h2">Campaign grades</h2>
          </div>
          <Card pad={false}>
            {grades.length === 0 ? (
              <Placeholder icon="megaphone" title="No data yet" sub="Campaign grades appear once your campaigns accrue spend and revenue." />
            ) : (
              <div className="cd-rows">
                {[...grades]
                  .sort((a, b) => b.roas - a.roas)
                  .map((g) => {
                    const below = g.break_even_roas > 0 && g.roas < g.break_even_roas;
                    return (
                      <button
                        key={g.campaign_id}
                        className="cd-row"
                        onClick={() => app.navigate("campaigns", g.campaign_id)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="cd-row-title truncate">{g.name}</span>
                            <GradePill grade={gradeFromRow(g)} />
                          </div>
                          <div className="cd-grade-track">
                            <div
                              className="cd-grade-fill"
                              style={{
                                width: `${Math.min(100, (g.roas / gradeMax) * 100)}%`,
                                background: below ? "var(--red)" : "var(--green)",
                              }}
                            ></div>
                            <div
                              className="cd-grade-be"
                              style={{ left: `${Math.min(100, (g.break_even_roas / gradeMax) * 100)}%` }}
                            ></div>
                          </div>
                        </div>
                        <span
                          className="cd-row-num tabular-nums"
                          style={{
                            color: below ? "var(--red)" : "var(--green)",
                            width: 52,
                            textAlign: "right",
                          }}
                        >
                          {g.roas.toFixed(1)}×
                        </span>
                      </button>
                    );
                  })}
              </div>
            )}
          </Card>
          <p className="cd-caption mt-2">
            Tick = your break-even ROAS for that campaign&apos;s products.
          </p>
        </section>

        <section className="min-w-0">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="cd-h2">Most-engaging ads</h2>
          </div>
          <Card pad={false}>
            {topAds.length === 0 ? (
              <Placeholder icon="sparkle" title="No data yet" sub="Your top-performing ads by engagement will list here." />
            ) : (
              <div className="cd-rows">
                {topAds.map((ad) => (
                  <div key={ad.ad_name} className="cd-row" style={{ cursor: "default" }}>
                    <div className="min-w-0 flex-1">
                      <div className="cd-row-title truncate">{ad.ad_name}</div>
                      <div className="cd-caption truncate">{ad.campaign_name}</div>
                      <div className="cd-grade-track" style={{ marginTop: 6 }}>
                        <div
                          className="cd-grade-fill"
                          style={{
                            width: `${(ad.engagement / maxEng) * 100}%`,
                            background: "var(--accent)",
                          }}
                        ></div>
                      </div>
                    </div>
                    <div className="text-right whitespace-nowrap">
                      <div className="cd-row-num tabular-nums">{ad.engagement.toLocaleString()}</div>
                      <div className="cd-caption tabular-nums">
                        {ad.saves.toLocaleString()} saves · {ad.shares.toLocaleString()} shares
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <p className="cd-caption mt-2">
            Engagement = reactions + comments + shares + saves, last 30 days.
          </p>
        </section>
      </div>

      {/* Operational cards relocated from the former Overview (now the Live Engine). */}
      <StatRow app={app} />
      <div className="cd-grid-main">
        <div className="flex flex-col gap-4 min-w-0">
          <FocusCard app={app} />
          <GuardrailCard app={app} />
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <ActivityFeed app={app} limit={7} tall />
        </div>
      </div>
      <AttentionSection app={app} />
      {benchmarks ? <PeerBenchmarks data={benchmarks} /> : null}
    </div>
  );
}
