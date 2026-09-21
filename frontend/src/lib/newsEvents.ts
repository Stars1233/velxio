/**
 * Product-news interaction sink ("What's New" telemetry seam).
 *
 * Same seam pattern as newsSource.ts / proSession.ts: OSS ships a no-op
 * default and an extension overlay may register a sink that forwards the
 * signals wherever it wants (velxio.dev sends them to its analytics
 * pipeline). A pure OSS build never reports anything anywhere — the
 * events below simply vanish.
 *
 * Event vocabulary (postId is always the news post's id):
 *   - impression  → the corner toast rendered for the user
 *   - open        → the full post modal was opened (detail.via:
 *                   'toast' | 'menu')
 *   - link_click  → a link inside the post body was clicked
 *                   (detail.href)
 *   - video_play  → a YouTube preview inside the body was started
 *                   (detail.href)
 *   - close       → the modal went away (detail.via says how,
 *                   detail.durationMs how long it was on screen while
 *                   the tab was visible, detail.scrollDepth how far the
 *                   body was scrolled, detail.interactions how many
 *                   links/videos were used before closing). Tells a
 *                   post that was read apart from one dismissed on sight.
 */

export type NewsEventKind = 'impression' | 'open' | 'link_click' | 'video_play' | 'close';

export type NewsOpenVia = 'toast' | 'menu';

/** How the modal was closed: the footer button, the header X, a click
 *  on the backdrop, the Escape key, or the page going away with the
 *  modal still up. */
export type NewsCloseVia = 'button' | 'x' | 'backdrop' | 'escape' | 'leave';

export interface NewsEventDetail {
  /** Target URL for link_click / video_play. */
  href?: string;
  /** How the modal was opened ('open') or closed ('close'). */
  via?: NewsOpenVia | NewsCloseVia;
  /** 'close': visible time on screen, in ms (hidden-tab time excluded). */
  durationMs?: number;
  /** 'close': deepest scroll reached in the body, 0..1 (1 when the body
   *  fits without scrolling). */
  scrollDepth?: number;
  /** 'close': links clicked + videos started while it was open. */
  interactions?: number;
}

type NewsEventSink = (
  kind: NewsEventKind,
  postId: string,
  detail?: NewsEventDetail,
) => void;

let _sink: NewsEventSink | null = null;

export function registerNewsEventSink(sink: NewsEventSink): void {
  _sink = sink;
}

/**
 * Report a news interaction. Never throws — telemetry must not be able
 * to break the announcement UI.
 */
export function reportNewsEvent(
  kind: NewsEventKind,
  postId: string,
  detail?: NewsEventDetail,
): void {
  try {
    _sink?.(kind, postId, detail);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.debug('[oss] news event sink failed:', err);
  }
}
