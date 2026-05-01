/**
 * Microsoft VS Marketplace adapter.
 *
 * The public gallery is reachable through the unauthenticated
 * extensionquery endpoint:
 *
 *   POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery
 *   Headers:
 *     Content-Type: application/json
 *     Accept: application/json;api-version=3.0-preview.1
 *   Body: { filters: [...], assetTypes: [], flags: <bitmask> }
 *
 * VSIX downloads are served from the publisher's CDN:
 *
 *   https://{publisher}.gallery.vsassets.io/_apis/public/gallery/
 *     publisher/{publisher}/extension/{name}/{version}/
 *     assetbyname/Microsoft.VisualStudio.Services.VSIXPackage
 *
 * **Licensing**: per the Marketplace terms of use, redistribution of
 * VSIX files is restricted. Rosetta does not ship VSIX content; it
 * proxies a one-shot download into the user's local extensions
 * directory at install time, exactly the same way `code --install-extension`
 * does for VS Code itself. The Logos workbench is responsible for
 * surfacing the marketplace ToS to the user before enabling this
 * gallery, and for honoring `tier === "private"` extensions.
 *
 * Filter type / flag values come from
 * https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryService.ts
 */
import { createHash } from "node:crypto";
import {
  galleryFetchBuffer,
  galleryFetchJson,
  type GalleryClient,
  type GalleryExtension,
  type GalleryQuery,
  type GallerySearchResult,
} from "./client.js";
import { partitionByCompatibility } from "./compatibility.js";

const DEFAULT_BASE = "https://marketplace.visualstudio.com";
const TARGET_VS_CODE = "Microsoft.VisualStudio.Code";

// Filter types (FilterType in vscode source).
const FILTER_TARGET = 8;
const FILTER_SEARCH_TEXT = 10;
const FILTER_EXTENSION_NAME = 7;

// SortBy values.
const SORT_BY: Record<NonNullable<GalleryQuery["sortBy"]>, number> = {
  relevance: 0,
  installs: 4,
  rating: 12,
  updated: 1,
};

// Flags — combine the bits we need for compat metadata.
//
//   0x1   IncludeVersions
//   0x2   IncludeFiles
//   0x4   IncludeCategoryAndTags
//   0x8   IncludeSharedAccounts
//   0x10  IncludeVersionProperties
//   0x100 IncludeStatistics
//   0x200 IncludeLatestVersionOnly
//   0x400 Unpublished
//   0x800 IncludeNameConflictInfo
//
// 0x113 = versions+files+versionProps+statistics-ish (matches what
// VS Code itself sends for catalog browsing).
const QUERY_FLAGS = 0x1 | 0x2 | 0x10 | 0x100 | 0x200;

const ASSET_VSIX = "Microsoft.VisualStudio.Services.VSIXPackage";
const ASSET_MANIFEST = "Microsoft.VisualStudio.Code.Manifest";
const ASSET_README = "Microsoft.VisualStudio.Services.Content.Details";
const ASSET_ICON_SMALL = "Microsoft.VisualStudio.Services.Icons.Small";
const ASSET_ICON_DEFAULT = "Microsoft.VisualStudio.Services.Icons.Default";

type VsmResults = {
  results: Array<{
    extensions: VsmExtension[];
    resultMetadata: Array<{
      metadataType: string;
      metadataItems: Array<{ name: string; count: number }>;
    }>;
  }>;
};

type VsmExtension = {
  publisher: { publisherName: string; displayName?: string };
  extensionName: string;
  displayName?: string;
  shortDescription?: string;
  versions: VsmVersion[];
  statistics?: Array<{ statisticName: string; value: number }>;
  releaseDate?: string;
  lastUpdated?: string;
  publishedDate?: string;
  flags?: string;
};

type VsmVersion = {
  version: string;
  flags?: string;
  lastUpdated?: string;
  files?: Array<{ assetType: string; source: string }>;
  properties?: Array<{ key: string; value: string }>;
  assetUri?: string;
  fallbackAssetUri?: string;
};

export type VsMarketplaceClientOptions = {
  baseUrl?: string;
  /**
   * The Microsoft Marketplace responds with an exhaustive payload that
   * does **not** include the parsed `package.json`. The client fetches
   * the per-version `Microsoft.VisualStudio.Code.Manifest` asset to
   * recover `activationEvents` / `contributes` for compatibility
   * scoring. Set to `false` to skip this and trust the search hit
   * blindly (faster, but the compatibility filter cannot reject).
   */
  fetchManifests?: boolean;
};

export class VsMarketplaceClient implements GalleryClient {
  readonly source = "vs-marketplace" as const;
  private readonly baseUrl: string;
  private readonly fetchManifests: boolean;

  constructor(opts: VsMarketplaceClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchManifests = opts.fetchManifests ?? true;
  }

  async search(query: GalleryQuery): Promise<GallerySearchResult> {
    const criteria: Array<{ filterType: number; value: string }> = [
      { filterType: FILTER_TARGET, value: TARGET_VS_CODE },
    ];
    if (query.extensionId) {
      criteria.push({ filterType: FILTER_EXTENSION_NAME, value: query.extensionId });
    } else if (query.text) {
      criteria.push({ filterType: FILTER_SEARCH_TEXT, value: query.text });
    }
    const body = {
      filters: [
        {
          criteria,
          pageNumber: Math.floor((query.offset ?? 0) / Math.max(query.limit ?? 25, 1)) + 1,
          pageSize: Math.min(query.limit ?? 25, 100),
          sortBy: SORT_BY[query.sortBy ?? "relevance"],
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: QUERY_FLAGS,
    };

    const url = `${this.baseUrl}/_apis/public/gallery/extensionquery`;
    const data = await galleryFetchJson<VsmResults>(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json;api-version=3.0-preview.1",
      },
      body: JSON.stringify(body),
    });

    const result = data.results[0];
    const extensions = result?.extensions ?? [];
    const total =
      result?.resultMetadata
        ?.find((m) => m.metadataType === "ResultCount")
        ?.metadataItems.find((it) => it.name === "TotalCount")?.count ?? extensions.length;

    const items = await Promise.all(
      extensions.map(async (ext) => {
        const base = this.toGalleryExtension(ext);
        if (!this.fetchManifests) return base;
        const manifestUrl = base.assets.manifest;
        if (!manifestUrl) return base;
        try {
          const manifestJson = await galleryFetchJson<Record<string, unknown>>(manifestUrl, {
            headers: { accept: "application/json" },
          });
          return mergeManifest(base, manifestJson);
        } catch {
          // Manifest fetch failures are non-fatal — the search row still
          // renders, but compatibility evaluation must fail closed.
          return base;
        }
      }),
    );

    const { runnable, rejected } = partitionByCompatibility(items);
    return {
      source: this.source,
      total,
      items: runnable,
      rejected: query.includeIncompatible ? rejected : [],
    };
  }

  async get(extensionId: string): Promise<GalleryExtension | null> {
    const result = await this.search({ extensionId, includeIncompatible: true, limit: 1 });
    return [...result.items, ...result.rejected][0] ?? null;
  }

  async download(
    extensionId: string,
    version?: string,
  ): Promise<{ vsix: Uint8Array; bytes: number; sha256: string }> {
    const ext = await this.get(extensionId);
    if (!ext) throw new Error(`VS Marketplace: extension not found: ${extensionId}`);
    const targetVersion = version ?? ext.version;
    // Build the canonical CDN URL. We do not use ext.assets.vsix
    // verbatim because some VSIX assets in the gallery point at
    // pre-signed URLs that expire; the canonical pattern is stable.
    const [publisher, name] = splitId(extensionId);
    const url = `https://${encodeURIComponent(publisher)}.gallery.vsassets.io/_apis/public/gallery/publisher/${encodeURIComponent(publisher)}/extension/${encodeURIComponent(name)}/${encodeURIComponent(targetVersion)}/assetbyname/${ASSET_VSIX}`;
    const buf = await galleryFetchBuffer(url);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return { vsix: buf, bytes: buf.byteLength, sha256 };
  }

  private toGalleryExtension(ext: VsmExtension): GalleryExtension {
    const v0 = ext.versions[0];
    if (!v0) {
      throw new Error(`VS Marketplace: extension ${ext.publisher.publisherName}.${ext.extensionName} has no versions`);
    }
    const id = `${ext.publisher.publisherName}.${ext.extensionName}`;
    const fileMap = new Map((v0.files ?? []).map((f) => [f.assetType, f.source]));
    const assetUri = v0.assetUri ?? v0.fallbackAssetUri ?? "";
    const vsix = fileMap.get(ASSET_VSIX) ?? `${assetUri}/${ASSET_VSIX}`;
    const manifest = fileMap.get(ASSET_MANIFEST) ?? (assetUri ? `${assetUri}/${ASSET_MANIFEST}` : undefined);
    const readme = fileMap.get(ASSET_README) ?? (assetUri ? `${assetUri}/${ASSET_README}` : undefined);
    const icon =
      fileMap.get(ASSET_ICON_DEFAULT) ??
      fileMap.get(ASSET_ICON_SMALL) ??
      (assetUri ? `${assetUri}/${ASSET_ICON_DEFAULT}` : undefined);

    const stats = new Map((ext.statistics ?? []).map((s) => [s.statisticName, s.value]));
    const installs = stats.get("install") ?? stats.get("downloadCount");
    const rating = stats.get("averagerating") ?? stats.get("weightedRating");
    const ratingCount = stats.get("ratingcount");

    const engineProp = (v0.properties ?? []).find((p) => p.key === "Microsoft.VisualStudio.Code.Engine");
    const publisherDisplay = ext.publisher.displayName;

    return {
      source: this.source,
      extensionId: id,
      publisher: {
        publisher: ext.publisher.publisherName,
        ...(publisherDisplay ? { displayName: publisherDisplay } : {}),
      },
      name: ext.extensionName,
      displayName: ext.displayName ?? ext.extensionName,
      description: ext.shortDescription ?? "",
      version: v0.version,
      lastUpdated: v0.lastUpdated ?? ext.lastUpdated ?? new Date(0).toISOString(),
      ...(installs !== undefined ? { installs } : {}),
      ...(rating !== undefined ? { rating } : {}),
      ...(ratingCount !== undefined ? { ratingCount } : {}),
      manifest: {
        name: ext.extensionName,
        publisher: ext.publisher.publisherName,
        version: v0.version,
        engines: { ...(engineProp ? { vscode: engineProp.value } : {}) },
        // contributes / activationEvents / capabilities arrive only
        // when we fetch the manifest asset. mergeManifest() folds
        // them in for the runnability check.
      },
      assets: {
        vsix,
        ...(manifest ? { manifest } : {}),
        ...(readme ? { readme } : {}),
        ...(icon ? { icon } : {}),
      },
      raw: ext,
    };
  }
}

function mergeManifest(base: GalleryExtension, parsed: Record<string, unknown>): GalleryExtension {
  // The manifest asset is the upstream package.json verbatim. We pull
  // only the fields the compatibility filter inspects so we don't bloat
  // the response over the wire.
  const activationEvents = isStringArray(parsed["activationEvents"]) ? (parsed["activationEvents"] as string[]) : undefined;
  const contributes = isPlainObject(parsed["contributes"]) ? (parsed["contributes"] as Record<string, unknown>) : undefined;
  const capabilities = isPlainObject(parsed["capabilities"]) ? (parsed["capabilities"] as { untrustedWorkspaces?: { supported: boolean }; virtualWorkspaces?: boolean }) : undefined;
  const extensionPack = isStringArray(parsed["extensionPack"]) ? (parsed["extensionPack"] as string[]) : undefined;
  const extensionDependencies = isStringArray(parsed["extensionDependencies"]) ? (parsed["extensionDependencies"] as string[]) : undefined;
  const main = typeof parsed["main"] === "string" ? (parsed["main"] as string) : undefined;
  const enginesParsed = isPlainObject(parsed["engines"])
    ? (parsed["engines"] as { vscode?: string; logos?: string })
    : undefined;

  return {
    ...base,
    manifest: {
      ...base.manifest,
      ...(main !== undefined ? { main } : {}),
      engines: { ...base.manifest.engines, ...enginesParsed },
      ...(activationEvents ? { activationEvents } : {}),
      ...(contributes ? { contributes } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(extensionPack ? { extensionPack } : {}),
      ...(extensionDependencies ? { extensionDependencies } : {}),
    },
  };
}

function splitId(extensionId: string): [string, string] {
  const dot = extensionId.indexOf(".");
  if (dot <= 0 || dot === extensionId.length - 1) {
    throw new Error(`invalid extensionId: ${extensionId} (expected <publisher>.<name>)`);
  }
  return [extensionId.slice(0, dot), extensionId.slice(dot + 1)];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
