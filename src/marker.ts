import type { ReconciledMarker } from './sections.js';

/**
 * The reconciled marker lives in one attachment per ticket, keyed by this
 * URL. Linear stores a description as a ProseMirror document with no node for
 * an HTML comment, so the marker as a description line showed to people as
 * literal `<!-- strict:reconciled … -->` text they could edit or delete.
 * An attachment is where Linear keeps an integration's state: it shows as one
 * card in the sidebar, its metadata is hidden, and `attachmentCreate` with the
 * same URL and issue updates that issue's record, replacing the metadata
 * whole (both checked live 2026-09-27).
 *
 * The URL is the README section explaining the card, so a person who clicks
 * it learns what it is. It is a section anchor rather than the repository
 * itself, so a person attaching the repository to a ticket is not mistaken
 * for the marker. The pull-request facts only read attachments whose source
 * is GitHub's integration and whose URL is a pull request, so this is not one.
 */
export const MARKER_URL = 'https://github.com/justinstimatze/linear-strict#reconciled-marker';

/** Where earlier versions kept the marker; read, and replaced on the next write. */
export const LEGACY_MARKER_URLS = ['https://www.npmjs.com/package/linear-strict'];

export const MARKER_URLS = [MARKER_URL, ...LEGACY_MARKER_URLS];

/** What the attachment's metadata holds. Linear takes string and number values only. */
export interface StoredMarker extends ReconciledMarker {
  /**
   * The description_sha of the description as this server last wrote it. A
   * different hash on read means someone changed the description outside this
   * server since, which a marker inside the text could never show.
   */
  sha?: string | undefined;
}

export interface MarkerAttachment {
  id: string;
  url: string;
  metadata: Record<string, unknown> | null;
}

export function markerFromAttachment(
  attachment: MarkerAttachment | undefined,
): StoredMarker | null {
  const data = attachment?.metadata;
  if (!data) return null;
  const text = (key: string) => (typeof data[key] === 'string' ? data[key] : undefined);
  const through = text('through');
  const at = text('at');
  const by = text('by');
  if (!through || !at || by === undefined) return null;
  return { through, at, by, checked: text('checked'), sha: text('sha') };
}

function shortDate(iso: string) {
  return iso.substring(0, 10);
}

/** The attachmentCreate input. Every key goes every time, since an upsert replaces the metadata whole. */
export function markerAttachmentInput(issueId: string, marker: StoredMarker, sha: string) {
  const metadata: Record<string, string | number> = {
    version: 1,
    through: marker.through,
    at: marker.at,
    by: marker.by,
    sha,
    ...(marker.checked ? { checked: marker.checked } : {}),
  };
  return {
    issueId,
    url: MARKER_URL,
    title: `linear-strict: description reconciled through ${shortDate(marker.at)}`,
    subtitle: `Comments up to ${shortDate(marker.at)} are reflected in the description${marker.checked ? `; checked ${shortDate(marker.checked)}` : ''}. Kept by linear-strict; deleting it only makes agents re-check the thread.`,
    metadata,
  };
}
