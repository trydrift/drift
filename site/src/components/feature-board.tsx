"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FEATURE_FORM_URL, FEATURES_API_URL, GITHUB_URL, readFeatureCache, normalizeFeatures, resolveBoardState, sortNew, sortShipped, sortTop, writeFeatureCache, type Feature } from "@/lib/github-features";

type View = "top" | "new" | "shipped";
const tabs: { id: View; label: string }[] = [{ id: "top", label: "Top" }, { id: "new", label: "New" }, { id: "shipped", label: "Shipped" }];

export function FeatureBoard() {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [view, setView] = useState<View>("top");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [hasCachedSnapshot, setHasCachedSnapshot] = useState(false);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const all: unknown[] = [];
      for (let page = 1; ; page++) {
        const response = await fetch(`${FEATURES_API_URL}?state=all&labels=feature-request&per_page=100&page=${page}`, { headers: { Accept: "application/vnd.github+json" } });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        const batch = await response.json() as unknown;
        if (!Array.isArray(batch)) throw new Error("Unexpected GitHub response");
        all.push(...batch); if (batch.length < 100) break;
      }
      const normalized = normalizeFeatures(all); if (active.current) { setFeatures(normalized); setHasCachedSnapshot(true); setRefreshError(false); localStorage.setItem("drift:feature-board", writeFeatureCache(normalized)); }
    } catch { if (active.current) setRefreshError(true); }
    finally { if (active.current) { setLoading(false); setRefreshing(false); } }
  }, []);
  useEffect(() => {
    const cached = readFeatureCache(localStorage.getItem("drift:feature-board"));
    if (cached.kind !== "invalid") { setFeatures(cached.features); setHasCachedSnapshot(true); setLoading(false); }
    if (cached.kind !== "fresh") void refresh();
  }, [refresh]);
  const boardState = resolveBoardState(hasCachedSnapshot, refreshError);
  const listed = view === "top" ? sortTop(features) : view === "new" ? sortNew(features) : sortShipped(features);
  return <section aria-labelledby="board-heading" className="mt-10">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 id="board-heading" className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Public board</h2><p className="mt-2 text-sm text-muted">Requests and votes live on GitHub.</p></div><div className="flex flex-wrap items-center gap-3"><div role="tablist" aria-label="Feature request views" className="flex rounded-lg border border-border bg-surface p-1">{tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={view === tab.id} onClick={() => setView(tab.id)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === tab.id ? "bg-surface-hover text-foreground" : "text-muted hover:text-foreground"}`}>{tab.label}</button>)}</div><button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh feature data from GitHub now" className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button></div></div>
    {boardState === "stale" && <p className="mt-4 text-xs text-faint">Could not refresh GitHub data. Showing cached data.</p>}
    {loading ? <div className="mt-5 space-y-3" aria-label="Loading feature requests"><div className="h-28 animate-pulse rounded-xl border border-border bg-surface" /><div className="h-28 animate-pulse rounded-xl border border-border bg-surface" /></div> : boardState === "error" ? <div className="mt-5 rounded-xl border border-dashed border-border bg-surface/60 p-8 text-center"><h3 className="font-serif text-xl text-landing">Feature data could not be loaded.</h3><p className="mt-2 text-sm text-muted"><a className="text-brand-text underline" href={`${GITHUB_URL}/issues?q=is%3Aissue+label%3Afeature-request`} target="_blank" rel="noreferrer">Browse feature requests on GitHub</a> or <a className="text-brand-text underline" href={FEATURE_FORM_URL} target="_blank" rel="noreferrer">create a feature request</a>.</p></div> : listed.length === 0 ? <div className="mt-5 rounded-xl border border-dashed border-border bg-surface/60 p-8 text-center"><h3 className="font-serif text-xl text-landing">{view === "shipped" ? "Nothing shipped yet." : "No feature requests yet."}</h3><p className="mt-2 text-sm text-muted">{view === "shipped" ? "Follow the board as ideas become part of Drift." : "Have something Drift should do? Start the board."}</p>{view === "shipped" ? <button type="button" onClick={() => setView("top")} className="mt-5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">Browse requests</button> : <a href={FEATURE_FORM_URL} target="_blank" rel="noreferrer" className="mt-5 inline-block rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground">Request the first feature</a>}</div> : <div className="mt-5 space-y-3">{listed.map((feature, index) => <FeatureRow key={feature.number} feature={feature} rank={index + 1} />)}</div>}
  </section>;
}

function FeatureRow({ feature, rank }: { feature: Feature; rank: number }) { return <article className="flex gap-4 rounded-xl border border-border bg-surface p-4 sm:p-5"><a href={feature.htmlUrl} target="_blank" rel="noreferrer" className="flex w-16 shrink-0 flex-col items-center justify-center rounded-lg border border-border bg-surface-hover/60 text-center text-faint hover:text-brand-text" aria-label={`Open ${feature.title} on GitHub to add a 👍 reaction; current count ${feature.votes}`}><span aria-hidden className="text-xl leading-none">▲</span><span className="mt-1 font-mono text-sm tabular">{feature.votes}</span><span className="mt-1 text-[10px]">GitHub</span></a><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><a href={feature.htmlUrl} target="_blank" rel="noreferrer" className="text-base font-medium text-foreground hover:text-brand-text">{feature.title}</a><span className="rounded-full border border-brand/40 bg-brand-soft px-2 py-0.5 text-[10px] text-brand-text">{feature.status}</span></div>{feature.excerpt && <p className="mt-2 text-sm leading-relaxed text-muted">{feature.excerpt}</p>}<p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-faint"><span>#{feature.number}</span><span>{feature.comments} {feature.comments === 1 ? "comment" : "comments"}</span><span>{feature.status === "Shipped" ? "Updated" : "Requested"} {new Date(feature.status === "Shipped" ? feature.updatedAt : feature.createdAt).toLocaleDateString()}</span><span>Rank {rank}</span></p></div></article>; }
