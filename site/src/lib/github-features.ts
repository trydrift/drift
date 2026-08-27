export const GITHUB_OWNER = "trydrift";
export const GITHUB_REPOSITORY = "drift";
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;
export const FEATURE_FORM_URL = `${GITHUB_URL}/issues/new?template=feature.yml`;
export const FEATURES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/issues`;
export const FEATURE_LABEL = "feature-request";
export const CACHE_SCHEMA = 1;
export const CACHE_TTL = 5 * 60 * 1000;

export type FeatureStatus = "Requested" | "Planned" | "In Progress" | "Shipped" | "Closed";

export interface Feature {
  number: number;
  title: string;
  excerpt: string;
  htmlUrl: string;
  state: "open" | "closed";
  status: FeatureStatus;
  votes: number;
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function hasLabel(issue: UnknownRecord, name: string): boolean {
  return Array.isArray(issue.labels) && issue.labels.some((label) => record(label)?.name === name);
}

export function deriveStatus(state: "open" | "closed", labels: readonly string[]): FeatureStatus {
  if (labels.includes("status: shipped")) return "Shipped";
  if (labels.includes("status: in-progress")) return "In Progress";
  if (labels.includes("status: planned")) return "Planned";
  return state === "closed" ? "Closed" : "Requested";
}

export function excerptFromBody(body: unknown): string {
  if (typeof body !== "string") return "";
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 220).replace(/\s+\S*$/, "").trim() || text.slice(0, 220);
}

export function normalizeFeature(value: unknown): Feature | null {
  const issue = record(value);
  if (!issue || "pull_request" in issue || typeof issue.number !== "number" || typeof issue.title !== "string" ||
      typeof issue.html_url !== "string" || (issue.state !== "open" && issue.state !== "closed") ||
      typeof issue.created_at !== "string" || typeof issue.updated_at !== "string") return null;
  if (!hasLabel(issue, FEATURE_LABEL)) return null;
  const labels = Array.isArray(issue.labels) ? issue.labels.flatMap((label) => {
    const name = record(label)?.name;
    return typeof name === "string" ? [name] : [];
  }) : [];
  const reactions = record(issue.reactions);
  const votes = typeof reactions?.["+1"] === "number" && reactions["+1"] >= 0 ? reactions["+1"] : 0;
  return {
    number: issue.number,
    title: issue.title,
    excerpt: excerptFromBody(issue.body),
    htmlUrl: issue.html_url,
    state: issue.state,
    status: deriveStatus(issue.state, labels),
    votes,
    comments: typeof issue.comments === "number" && issue.comments >= 0 ? issue.comments : 0,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: typeof issue.closed_at === "string" ? issue.closed_at : null,
  };
}

export function normalizeFeatures(values: unknown): Feature[] {
  return Array.isArray(values) ? values.flatMap((value) => { const feature = normalizeFeature(value); return feature ? [feature] : []; }) : [];
}

export function sortTop(features: readonly Feature[]): Feature[] {
  return [...features].filter((feature) => feature.status !== "Shipped" && feature.state === "open")
    .sort((a, b) => b.votes - a.votes || Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number);
}
export function sortNew(features: readonly Feature[]): Feature[] {
  return [...features].filter((feature) => feature.status !== "Shipped" && feature.state === "open")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number);
}
export function sortShipped(features: readonly Feature[]): Feature[] {
  return [...features].filter((feature) => feature.status === "Shipped")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
}

export interface FeatureCache { schema: number; cachedAt: number; features: Feature[]; }
export function readFeatureCache(raw: string | null, now = Date.now()): Feature[] | null {
  if (!raw) return null;
  try { const cache = JSON.parse(raw) as FeatureCache; return cache.schema === CACHE_SCHEMA && now - cache.cachedAt < CACHE_TTL && Array.isArray(cache.features) ? cache.features : null; }
  catch { return null; }
}
export function writeFeatureCache(features: Feature[], cachedAt = Date.now()): string {
  return JSON.stringify({ schema: CACHE_SCHEMA, cachedAt, features } satisfies FeatureCache);
}
