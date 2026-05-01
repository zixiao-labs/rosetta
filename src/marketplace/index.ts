/**
 * Unified gallery façade.
 *
 * The Logos workbench routes a single `marketplace/{search,get,download}`
 * call into Rosetta. The {@link MarketplaceManager} fans the call out to
 * the configured galleries (OpenVSX by default, optionally the
 * Microsoft VS Marketplace), merges results, and applies the
 * compatibility filter so the workbench never has to know about the
 * per-gallery wire formats.
 *
 * Galleries are first-class options, not flags: an admin deployment
 * can disable VS Marketplace (license-sensitive) or point OpenVSX at
 * an internal mirror. The defaults match what an unmanaged Logos
 * install ships with.
 */
import { OpenVsxClient, type OpenVsxClientOptions } from "./openvsx.js";
import { VsMarketplaceClient, type VsMarketplaceClientOptions } from "./vsMarketplace.js";
import type {
  GalleryClient,
  GalleryExtension,
  GalleryQuery,
  GallerySearchResult,
  GallerySource,
} from "./client.js";

export type MarketplaceConfig = {
  openvsx?: false | OpenVsxClientOptions;
  vsMarketplace?: false | VsMarketplaceClientOptions;
  /**
   * Default gallery used when a query/get/download omits `source`.
   * OpenVSX is the default because it's MIT-licensed and matches the
   * "no Microsoft account required" posture of the Workstation edition.
   */
  defaultSource?: GallerySource;
};

export type MarketplaceSearchParams = GalleryQuery & {
  /** Restrict to a single gallery. Default: every enabled gallery. */
  source?: GallerySource;
};

export type MarketplaceGetParams = {
  extensionId: string;
  source?: GallerySource;
};

export type MarketplaceDownloadParams = {
  extensionId: string;
  source?: GallerySource;
  version?: string;
};

export type AggregatedSearchResult = {
  /** Per-gallery breakdown so the UI can show "OpenVSX (12) | MS (4)". */
  bySource: Record<GallerySource, GallerySearchResult>;
  /** Flattened, deduplicated, runnable items across galleries. */
  items: GallerySearchResult["items"];
  /** Items dropped by the compatibility filter (only if `includeIncompatible`). */
  rejected: GallerySearchResult["rejected"];
  /** Sum of `total` across galleries. */
  total: number;
};

const DEFAULT_CONFIG: Required<Omit<MarketplaceConfig, "openvsx" | "vsMarketplace">> & {
  openvsx: OpenVsxClientOptions | false;
  vsMarketplace: VsMarketplaceClientOptions | false;
} = {
  openvsx: {},
  vsMarketplace: {},
  defaultSource: "openvsx",
};

export class MarketplaceManager {
  private readonly clients = new Map<GallerySource, GalleryClient>();
  private readonly defaultSource: GallerySource;

  constructor(config: MarketplaceConfig = {}) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    if (merged.openvsx !== false) {
      this.clients.set("openvsx", new OpenVsxClient(merged.openvsx));
    }
    if (merged.vsMarketplace !== false) {
      this.clients.set("vs-marketplace", new VsMarketplaceClient(merged.vsMarketplace));
    }
    this.defaultSource = merged.defaultSource;
    if (this.clients.size === 0) {
      throw new Error("MarketplaceManager: at least one gallery must be enabled");
    }
  }

  enabledSources(): GallerySource[] {
    return [...this.clients.keys()];
  }

  async search(params: MarketplaceSearchParams): Promise<AggregatedSearchResult> {
    const targets = params.source ? [params.source] : [...this.clients.keys()];
    const bySource: Partial<Record<GallerySource, GallerySearchResult>> = {};

    const settled = await Promise.allSettled(
      targets.map(async (src) => {
        const client = this.clients.get(src);
        if (!client) {
          throw new Error(`gallery source not enabled: ${src}`);
        }
        const result = await client.search(params);
        return [src, result] as const;
      }),
    );

    for (const [i, s] of settled.entries()) {
      const src = targets[i]!;
      if (s.status === "fulfilled") {
        bySource[src] = s.value[1];
      } else {
        // Surface the error as an empty page rather than failing the
        // whole multi-gallery query — one outage shouldn't take the
        // browse pane down.
        bySource[src] = {
          source: src,
          total: 0,
          items: [],
          rejected: [],
        };
      }
    }

    const allRunnable = targets.flatMap((s) => bySource[s]?.items ?? []);
    const allRejected = targets.flatMap((s) => bySource[s]?.rejected ?? []);
    const total = targets.reduce((acc, s) => acc + (bySource[s]?.total ?? 0), 0);

    // Deduplicate by extensionId — a publisher may live on both
    // galleries. Prefer OpenVSX because that's our default trust path.
    const dedupRunnable = dedupePreferring(allRunnable, ["openvsx", "vs-marketplace"]);
    const dedupRejected = dedupePreferring(allRejected, ["openvsx", "vs-marketplace"]);

    return {
      bySource: bySource as Record<GallerySource, GallerySearchResult>,
      items: dedupRunnable,
      rejected: dedupRejected,
      total,
    };
  }

  async get(params: MarketplaceGetParams): Promise<GalleryExtension | null> {
    const sources = params.source ? [params.source] : [this.defaultSource, ...this.enabledSources().filter((s) => s !== this.defaultSource)];
    for (const src of sources) {
      const client = this.clients.get(src);
      if (!client) continue;
      try {
        const hit = await client.get(params.extensionId);
        if (hit) return hit;
      } catch {
        // try next gallery
      }
    }
    return null;
  }

  async download(params: MarketplaceDownloadParams): Promise<{
    source: GallerySource;
    extensionId: string;
    version: string;
    bytes: number;
    sha256: string;
    /**
     * The VSIX bytes themselves are not returned over the JSON-RPC
     * wire — they are written to a temporary path inside the user
     * data dir and the path is returned to the workbench. For the
     * in-process API we expose the buffer directly.
     */
    vsix: Uint8Array;
  }> {
    const src = params.source ?? this.defaultSource;
    const client = this.clients.get(src);
    if (!client) throw new Error(`gallery source not enabled: ${src}`);
    const meta = await client.get(params.extensionId);
    const version = params.version ?? meta?.version;
    if (!version) throw new Error(`download: cannot resolve a version for ${params.extensionId}`);
    const blob = await client.download(params.extensionId, version);
    return {
      source: src,
      extensionId: params.extensionId,
      version,
      bytes: blob.bytes,
      sha256: blob.sha256,
      vsix: blob.vsix,
    };
  }
}

function dedupePreferring<T extends { extensionId: string; source: GallerySource }>(
  items: readonly T[],
  preference: readonly GallerySource[],
): T[] {
  const rank = new Map(preference.map((s, i) => [s, i] as const));
  const out = new Map<string, T>();
  for (const item of items) {
    const existing = out.get(item.extensionId);
    if (!existing) {
      out.set(item.extensionId, item);
      continue;
    }
    const a = rank.get(existing.source) ?? Number.MAX_SAFE_INTEGER;
    const b = rank.get(item.source) ?? Number.MAX_SAFE_INTEGER;
    if (b < a) out.set(item.extensionId, item);
  }
  return [...out.values()];
}

export type {
  GalleryClient,
  GalleryExtension,
  GalleryQuery,
  GallerySearchResult,
  GallerySource,
} from "./client.js";
export { evaluateCompatibility, type CompatibilityReport } from "./compatibility.js";
