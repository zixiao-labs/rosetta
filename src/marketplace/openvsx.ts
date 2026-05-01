/**
 * OpenVSX gallery adapter.
 *
 * Endpoint reference: https://open.vsx.org/api (v1).
 *
 *   GET  /api/-/search?query=<text>&size=<n>&offset=<m>&sortBy=<...>
 *   GET  /api/{namespace}/{name}                     → "extension info"
 *   GET  /api/{namespace}/{name}/{version}           → "extension info" pinned
 *   GET  /api/{namespace}/{name}/{version}/file/{namespace}.{name}-{version}.vsix
 *
 * The shape of the responses is documented at
 * https://open.vsx.org/swagger-ui/index.html. We pull only what the
 * Rosetta workbench needs, keeping the original payload in `raw`.
 */
import { createHash } from "node:crypto";
import {
  galleryFetchBuffer,
  galleryFetchJson,
  splitId,
  type GalleryClient,
  type GalleryExtension,
  type GalleryQuery,
  type GallerySearchResult,
} from "./client.js";
import { partitionByCompatibility } from "./compatibility.js";

const DEFAULT_BASE = "https://open.vsx.org";

type OpenVsxSearchHit = {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  averageRating?: number;
  reviewCount?: number;
  downloadCount?: number;
  timestamp?: string;
  files?: Record<string, string>;
  url?: string;
};

type OpenVsxSearchResponse = {
  offset: number;
  totalSize: number;
  extensions: OpenVsxSearchHit[];
};

type OpenVsxExtensionInfo = {
  namespace: string;
  name: string;
  version: string;
  publishedBy?: { loginName?: string; fullName?: string };
  displayName?: string;
  description?: string;
  averageRating?: number;
  reviewCount?: number;
  downloadCount?: number;
  timestamp?: string;
  files?: Record<string, string>;
  /** OpenVSX returns the parsed package.json under various keys. */
  engines?: Record<string, string>;
  activationEvents?: string[];
  contributes?: Record<string, unknown>;
  capabilities?: { untrustedWorkspaces?: { supported: boolean }; virtualWorkspaces?: boolean };
  extensionPack?: string[];
  extensionDependencies?: string[];
  main?: string;
};

const SORT_MAP: Record<NonNullable<GalleryQuery["sortBy"]>, string> = {
  relevance: "relevance",
  installs: "downloadCount",
  rating: "averageRating",
  updated: "timestamp",
};

export type OpenVsxClientOptions = {
  /** Override the gallery base URL (e.g. for an enterprise mirror). */
  baseUrl?: string;
};

export class OpenVsxClient implements GalleryClient {
  readonly source = "openvsx" as const;
  private readonly baseUrl: string;

  constructor(opts: OpenVsxClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  async search(query: GalleryQuery): Promise<GallerySearchResult> {
    if (query.extensionId) {
      const hit = await this.get(query.extensionId);
      const items = hit ? [hit] : [];
      const { runnable, rejected } = partitionByCompatibility(items);
      return {
        source: this.source,
        total: items.length,
        items: runnable,
        rejected: query.includeIncompatible ? rejected : [],
      };
    }

    const params = new URLSearchParams();
    if (query.text) params.set("query", query.text);
    params.set("size", String(Math.min(query.limit ?? 25, 100)));
    params.set("offset", String(query.offset ?? 0));
    if (query.sortBy) params.set("sortBy", SORT_MAP[query.sortBy]);

    const url = `${this.baseUrl}/api/-/search?${params.toString()}`;
    const data = await galleryFetchJson<OpenVsxSearchResponse>(url);

    // The /search endpoint returns a thin record. To run compatibility
    // we need contributes/activationEvents which only the per-extension
    // info endpoint carries. We resolve in parallel, capped to limit.
    const detailed = await Promise.all(
      data.extensions.map((hit) =>
        this.get(`${hit.namespace}.${hit.name}`).catch((err) => {
          // Don't poison the whole search if one item 404s mid-flight.
          // Surface as a stub so the UI can render the placeholder
          // instead of vanishing the row.
          return this.fromSearchHit(hit, err);
        }),
      ),
    );
    const items = detailed.filter((x): x is GalleryExtension => x !== null);

    const { runnable, rejected } = partitionByCompatibility(items);
    return {
      source: this.source,
      total: data.totalSize,
      items: runnable,
      rejected: query.includeIncompatible ? rejected : [],
    };
  }

  async get(extensionId: string): Promise<GalleryExtension | null> {
    const [namespace, name] = splitId(extensionId);
    const url = `${this.baseUrl}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    let info: OpenVsxExtensionInfo;
    try {
      info = await galleryFetchJson<OpenVsxExtensionInfo>(url);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return this.toGalleryExtension(info);
  }

  async download(
    extensionId: string,
    version?: string,
  ): Promise<{ vsix: Uint8Array; bytes: number; sha256: string }> {
    const [namespace, name] = splitId(extensionId);
    const meta = await this.get(extensionId);
    if (!meta) throw new Error(`OpenVSX: extension not found: ${extensionId}`);
    const targetVersion = version ?? meta.version;
    // When the caller pins a specific version we must not reuse
    // `meta.assets.vsix`: that URL points at `meta.version` (the latest)
    // and a naive `.replace("/<latest>/", "/<target>/")` is brittle —
    // the OpenVSX `files["download"]` value occasionally lacks the
    // version segment, leaving the substitution as a no-op and
    // silently downloading the wrong VSIX. Construct the pinned URL
    // directly from the documented OpenVSX route, falling back to the
    // gallery-supplied URL only when we are downloading the latest
    // version anyway.
    const pinned = `${this.baseUrl}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(targetVersion)}/file/${encodeURIComponent(`${namespace}.${name}-${targetVersion}.vsix`)}`;
    const url =
      version !== undefined && version !== meta.version
        ? pinned
        : meta.assets.vsix || pinned;
    const buf = await galleryFetchBuffer(url);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return { vsix: buf, bytes: buf.byteLength, sha256 };
  }

  private toGalleryExtension(info: OpenVsxExtensionInfo): GalleryExtension {
    const id = `${info.namespace}.${info.name}`;
    const files = info.files ?? {};
    const vsix =
      files["download"] ??
      `${this.baseUrl}/api/${encodeURIComponent(info.namespace)}/${encodeURIComponent(info.name)}/${encodeURIComponent(info.version)}/file/${encodeURIComponent(`${info.namespace}.${info.name}-${info.version}.vsix`)}`;
    const publisherDisplay = info.publishedBy?.fullName ?? info.publishedBy?.loginName;
    return {
      source: this.source,
      extensionId: id,
      publisher: {
        publisher: info.namespace,
        ...(publisherDisplay !== undefined ? { displayName: publisherDisplay } : {}),
      },
      name: info.name,
      displayName: info.displayName ?? info.name,
      description: info.description ?? "",
      version: info.version,
      lastUpdated: info.timestamp ?? new Date(0).toISOString(),
      ...(info.downloadCount !== undefined ? { installs: info.downloadCount } : {}),
      ...(info.averageRating !== undefined ? { rating: info.averageRating } : {}),
      ...(info.reviewCount !== undefined ? { ratingCount: info.reviewCount } : {}),
      manifest: {
        name: info.name,
        publisher: info.namespace,
        version: info.version,
        ...(info.main !== undefined ? { main: info.main } : {}),
        engines: info.engines ?? {},
        ...(info.activationEvents ? { activationEvents: info.activationEvents } : {}),
        ...(info.contributes ? { contributes: info.contributes } : {}),
        ...(info.capabilities ? { capabilities: info.capabilities } : {}),
        ...(info.extensionPack ? { extensionPack: info.extensionPack } : {}),
        ...(info.extensionDependencies ? { extensionDependencies: info.extensionDependencies } : {}),
      },
      assets: {
        vsix,
        ...(files["readme"] ? { readme: files["readme"] } : {}),
        ...(files["icon"] ? { icon: files["icon"] } : {}),
        ...(files["manifest"] ? { manifest: files["manifest"] } : {}),
      },
      raw: info,
    };
  }

  private fromSearchHit(hit: OpenVsxSearchHit, err: unknown): GalleryExtension {
    // We could not fetch the per-extension info (rate limit, transient
    // 5xx). Build a minimal record so the UI can render the row with
    // an "info unavailable" badge. The empty manifest below would
    // otherwise pass `evaluateCompatibility` (no contributes /
    // activationEvents → nothing to flag → runnable=true), which is
    // the opposite of fail-closed. Stamp an explicit compatibility
    // verdict so partitionByCompatibility drops the row into the
    // rejected set.
    const id = `${hit.namespace}.${hit.name}`;
    const fetchReason = err instanceof Error ? err.message : String(err);
    return {
      source: this.source,
      extensionId: id,
      publisher: { publisher: hit.namespace },
      name: hit.name,
      displayName: hit.displayName ?? hit.name,
      description: hit.description ?? "",
      version: hit.version,
      lastUpdated: hit.timestamp ?? new Date(0).toISOString(),
      ...(hit.downloadCount !== undefined ? { installs: hit.downloadCount } : {}),
      ...(hit.averageRating !== undefined ? { rating: hit.averageRating } : {}),
      ...(hit.reviewCount !== undefined ? { ratingCount: hit.reviewCount } : {}),
      manifest: {
        name: hit.name,
        publisher: hit.namespace,
        version: hit.version,
        engines: {},
      },
      assets: {
        vsix:
          hit.files?.["download"] ??
          `${this.baseUrl}/api/${encodeURIComponent(hit.namespace)}/${encodeURIComponent(hit.name)}/${encodeURIComponent(hit.version)}/file/${encodeURIComponent(`${hit.namespace}.${hit.name}-${hit.version}.vsix`)}`,
        ...(hit.files?.["readme"] ? { readme: hit.files["readme"] } : {}),
        ...(hit.files?.["icon"] ? { icon: hit.files["icon"] } : {}),
      },
      raw: { hit, fetchError: fetchReason },
      compatibility: {
        runnable: false,
        reason: `OpenVSX details unavailable for ${id}: ${fetchReason}`,
        unsupportedContributions: [],
        unsupportedActivationEvents: [],
        notes: [
          `details fetch failed (${fetchReason}); manifest contents unknown — failing closed`,
        ],
      },
    };
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}
