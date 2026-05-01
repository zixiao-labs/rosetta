/**
 * Marketplace gallery client — public types and the small fetch helper
 * shared by the OpenVSX and VS Marketplace adapters.
 *
 * The gallery layer in Rosetta only resolves *metadata* and *VSIX
 * downloads*. Installation, signature verification, sandbox preparation,
 * and the actual `extension/activate` call still live in the Logos
 * workbench — see README.md "Marketplace inspection". This file is
 * deliberately I/O-only so the workbench can swap or stack additional
 * inspection passes without touching the host code.
 */

import type { CompatibilityReport, CompatibilityInput } from "./compatibility.js";

export type GallerySource = "openvsx" | "vs-marketplace";

export type GalleryQuery = {
  /** Free-text search. Ignored when {@link extensionId} is set. */
  text?: string;
  /** Look up a single extension by `<publisher>.<name>`. */
  extensionId?: string;
  /** 0-based offset for paging. Default 0. */
  offset?: number;
  /** Page size. Default 25, capped at 100. */
  limit?: number;
  /** Optional sort. Defaults to gallery-native popularity. */
  sortBy?: "relevance" | "installs" | "rating" | "updated";
  /**
   * If true, return all results including ones Rosetta cannot run.
   * The default `false` mirrors the user's expectation that the
   * "Browse extensions" pane shows runnable items only.
   */
  includeIncompatible?: boolean;
};

export type GalleryAuthor = {
  publisher: string;
  displayName?: string;
};

export type GalleryAsset = {
  /** Direct, no-auth-required URL of the .vsix. */
  vsix: string;
  /** Optional README rendered as HTML or markdown URL. */
  readme?: string;
  /** Optional 256x256 (or larger) icon URL. */
  icon?: string;
  /** Optional Microsoft / OpenVSX manifest URL (raw `package.json`). */
  manifest?: string;
};

/**
 * Common shape produced by both OpenVSX and VS Marketplace adapters
 * after they normalize their proprietary response. Anything proprietary
 * stays inside the per-source `raw` blob so the workbench can dig in
 * without us having to re-flatten every quirk.
 */
export type GalleryExtension = {
  source: GallerySource;
  /** `<publisher>.<name>` — the canonical id used by Logos. */
  extensionId: string;
  publisher: GalleryAuthor;
  name: string;
  displayName: string;
  description: string;
  version: string;
  /** ISO timestamp; what the gallery considers "latest update". */
  lastUpdated: string;
  /** Total install count where the gallery exposes one. */
  installs?: number;
  /** Average user rating (0..5). */
  rating?: number;
  ratingCount?: number;
  /** Subset of the `package.json` manifest the gallery returned. */
  manifest: CompatibilityInput & {
    /** Always present in the gallery response; stored verbatim. */
    name: string;
    publisher: string;
    version: string;
    main?: string;
    engines: { vscode?: string; logos?: string };
  };
  assets: GalleryAsset;
  /** Provenance blob from the gallery, untouched. */
  raw: unknown;
  /**
   * Optional pre-computed compatibility verdict. Adapters use this to
   * fail closed when they cannot vouch for the manifest (e.g. the
   * details fetch failed and only a search-hit stub is available).
   * When unset, {@link partitionByCompatibility} runs
   * {@link evaluateCompatibility} against `manifest`.
   */
  compatibility?: CompatibilityReport;
};

export type GalleryExtensionWithCompat = GalleryExtension & {
  compatibility: CompatibilityReport;
};

export type GallerySearchResult = {
  source: GallerySource;
  /** Total matches the gallery reports (not the page size). */
  total: number;
  /** Items already filtered/decorated by the compatibility check. */
  items: GalleryExtensionWithCompat[];
  /** Items hidden because they cannot run. Empty unless `includeIncompatible`. */
  rejected: GalleryExtensionWithCompat[];
};

export interface GalleryClient {
  readonly source: GallerySource;
  search(query: GalleryQuery): Promise<GallerySearchResult>;
  /** Resolve a single extension by `<publisher>.<name>`. */
  get(extensionId: string): Promise<GalleryExtension | null>;
  /** Stream a VSIX into a Buffer. The host writes it to disk. */
  download(extensionId: string, version?: string): Promise<{ vsix: Uint8Array; bytes: number; sha256: string }>;
}

/**
 * Tiny fetch wrapper that:
 *   - sets a Rosetta-identifying User-Agent (galleries throttle anonymous);
 *   - propagates AbortSignal when the workbench cancels;
 *   - rejects with a structured error so the dispatcher can surface
 *     `{ code, message }` over the wire instead of a stringified Error.
 */
export type FetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /** Default: throws on !ok. Pass `false` to inspect failed responses. */
  throwOnHttpError?: boolean;
};

export class GalleryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "GalleryHttpError";
  }
}

const USER_AGENT = "Rosetta/1.x (+https://github.com/zixiao-labs/rosetta)";

/**
 * Hard deadline applied to every gallery request. The public OpenVSX and
 * Microsoft Marketplace endpoints normally answer in under a second; a
 * minute is generous enough to absorb a slow VSIX download on a poor
 * connection while still preventing a stalled TCP connection from
 * hanging the workbench's "Browse extensions" pane indefinitely. The
 * dispatcher relays the abort as a -32000 error.
 */
const GALLERY_FETCH_TIMEOUT_MS = 60_000;

export async function galleryFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json",
    ...opts.headers,
  };
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined) {
    // Node 20+ fetch accepts string and Uint8Array directly; the cast
    // sidesteps the optional `BodyInit` lib type which is not in
    // `@types/node` without `lib.dom`.
    (init as { body?: unknown }).body = opts.body;
  }

  // Combine our internal deadline with any caller-supplied AbortSignal so
  // either side can short-circuit the request. The timer must be cleared
  // in both the success and error paths to avoid leaking a Node timer
  // (each held timer keeps the event loop alive).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GALLERY_FETCH_TIMEOUT_MS);
  let upstreamAbortHandler: (() => void) | undefined;
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      upstreamAbortHandler = () => controller.abort();
      opts.signal.addEventListener("abort", upstreamAbortHandler, { once: true });
    }
  }
  init.signal = controller.signal;

  try {
    const res = await fetch(url, init);
    if (!res.ok && opts.throwOnHttpError !== false) {
      throw new GalleryHttpError(
        `${opts.method ?? "GET"} ${url} → ${res.status} ${res.statusText}`,
        res.status,
        url,
      );
    }
    return res;
  } finally {
    clearTimeout(timeoutId);
    if (upstreamAbortHandler && opts.signal) {
      opts.signal.removeEventListener("abort", upstreamAbortHandler);
    }
  }
}

export async function galleryFetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await galleryFetch(url, opts);
  return (await res.json()) as T;
}

export async function galleryFetchBuffer(url: string, opts: FetchOptions = {}): Promise<Uint8Array> {
  const res = await galleryFetch(url, opts);
  const arr = new Uint8Array(await res.arrayBuffer());
  return arr;
}

/**
 * Split a `<publisher>.<name>` extension id. Both gallery adapters parse
 * this the same way; the helper lives here so the two copies cannot drift.
 */
export function splitId(extensionId: string): [string, string] {
  const dot = extensionId.indexOf(".");
  if (dot <= 0 || dot === extensionId.length - 1) {
    throw new Error(`invalid extensionId: ${extensionId} (expected <publisher>.<name>)`);
  }
  return [extensionId.slice(0, dot), extensionId.slice(dot + 1)];
}
