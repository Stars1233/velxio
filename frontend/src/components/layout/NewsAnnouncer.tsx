/**
 * Product news ("What's New") — an announcement modal on editor entry.
 *
 * This started life as an auto-opened modal, was demoted to a corner
 * toast (it used to stack on top of the starter-template dialog), and is
 * now a modal again — the toast simply went unread. What makes the modal
 * viable this time is sequencing, not stacking: EditorPage holds the
 * pristine-visit "Start a new project" dialog until this component
 * reports through lib/newsGate.ts that news is out of the way (nothing
 * to show, or the modal was closed). One startup overlay on screen at a
 * time, announcement first — and the announcement renders slightly wider
 * than the starter dialog so it reads as the headline, not a leftover.
 *
 * The queue/seen logic lives in lib/newsSource.ts (OSS: localStorage
 * over /api/news/feed; pro: server-backed per user). The fetch starts
 * almost immediately — the starter dialog is waiting on the decision —
 * and every failure path resolves to "nothing shown", which opens the
 * gate. The last delivered post stays reachable from Help ▸ What's new.
 *
 * Every showing ends in exactly one 'close' event that says how it was
 * closed, how long it was on screen (visible-tab time only, so a reader
 * who opened a link in a new tab is not credited with that time), how
 * far the body was scrolled and how many links were used: the
 * difference between a post that was read and one dismissed on sight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getNextNews, type NewsPost } from '../../lib/newsSource';
import { reportNewsEvent, type NewsCloseVia } from '../../lib/newsEvents';
import { markNewsShowing, markNewsNone, markNewsClosed } from '../../lib/newsGate';
import { NewsMarkdown } from './NewsMarkdown';
import { registerEditorCommand } from '../../lib/editorCommands';
import './NewsAnnouncer.css';

/** One tick of breathing room so the fetch never competes with the very
 *  first render burst; kept tiny because the starter dialog waits on us. */
const FETCH_DELAY_MS = 250;

/** One open-to-close span of the modal. */
interface Showing {
  postId: string;
  visibleMs: number;
  /** performance.now() when the tab last became visible; null while hidden. */
  visibleSince: number | null;
  scrollDepth: number;
  interactions: number;
}

function startShowing(postId: string): Showing {
  return {
    postId,
    visibleMs: 0,
    visibleSince: document.visibilityState === 'visible' ? performance.now() : null,
    scrollDepth: 0,
    interactions: 0,
  };
}

function scrollDepthOf(el: HTMLElement): number {
  const scrollable = el.scrollHeight - el.clientHeight;
  if (scrollable <= 1) return 1;
  return Math.min(1, Math.max(0, el.scrollTop / scrollable));
}

export function NewsAnnouncer() {
  const { t } = useTranslation();
  const [post, setPost] = useState<NewsPost | null>(null);
  const [expanded, setExpanded] = useState(false);
  const showing = useRef<Showing | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /** Report the current showing as closed. Idempotent: the first caller
   *  wins, so a pagehide after a click-close reports nothing twice. */
  const endShowing = useCallback((via: NewsCloseVia) => {
    const s = showing.current;
    if (!s) return;
    showing.current = null;
    const visibleMs =
      s.visibleMs + (s.visibleSince !== null ? performance.now() - s.visibleSince : 0);
    reportNewsEvent('close', s.postId, {
      via,
      durationMs: Math.round(visibleMs),
      scrollDepth: Math.round(s.scrollDepth * 100) / 100,
      interactions: s.interactions,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void getNextNews().then((p) => {
        if (cancelled) return;
        if (!p) {
          markNewsNone();
          return;
        }
        setPost(p);
        setExpanded(true);
        markNewsShowing();
        showing.current = startShowing(p.id);
        reportNewsEvent('impression', p.id);
      });
    }, FETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // No gate call in cleanup: a cancelled fetch leaves the gate
    // 'pending', and whenNewsClear's pending timeout covers that path.
  }, []);

  // Help ▸ What's new re-opens the last delivered post. Registered even
  // with nothing to show yet; the handler no-ops until a post arrives,
  // which keeps the menu row's enabled state honest once one has.
  useEffect(() => {
    if (!post) return;
    return registerEditorCommand('help.whatsNew', () => {
      if (!showing.current) showing.current = startShowing(post.id);
      setExpanded(true);
      reportNewsEvent('open', post.id, { via: 'menu' });
    });
  }, [post]);

  // While the modal is up: Escape closes it, hidden-tab time is not
  // counted, and leaving the page still reports how the showing ended.
  useEffect(() => {
    if (!post || !expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      endShowing('escape');
      setExpanded(false);
      markNewsClosed();
    };
    const onVisibility = () => {
      const s = showing.current;
      if (!s) return;
      if (document.visibilityState === 'visible') {
        if (s.visibleSince === null) s.visibleSince = performance.now();
      } else if (s.visibleSince !== null) {
        s.visibleMs += performance.now() - s.visibleSince;
        s.visibleSince = null;
      }
    };
    const onPageHide = () => endShowing('leave');
    const body = bodyRef.current;
    const onScroll = () => {
      const s = showing.current;
      if (s && body) s.scrollDepth = Math.max(s.scrollDepth, scrollDepthOf(body));
    };
    // A body that fits without scrolling counts as fully seen; images
    // load late and can make it scrollable, which onScroll then tracks.
    onScroll();
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    body?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      body?.removeEventListener('scroll', onScroll);
    };
  }, [post, expanded, endShowing]);

  if (!post || !expanded) return null;

  const close = (via: NewsCloseVia) => {
    endShowing(via);
    setExpanded(false);
    markNewsClosed();
  };

  return createPortal(
    <div className="velxio-news-overlay" onClick={() => close('backdrop')}>
      <div
        className="velxio-news-modal"
        role="dialog"
        aria-modal="true"
        aria-label={post.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="velxio-news-header">
          <div>
            <span className="velxio-news-kicker">
              {t('news.kicker', "What's new")}
            </span>
            <h2 className="velxio-news-title">{post.title}</h2>
          </div>
          <button
            className="velxio-news-close"
            aria-label={t('news.close', 'Close')}
            onClick={() => close('x')}
          >
            ×
          </button>
        </div>
        <div className="velxio-news-body" ref={bodyRef}>
          <NewsMarkdown
            onInteract={(kind, href) => {
              if (showing.current) showing.current.interactions += 1;
              reportNewsEvent(
                kind === 'video' ? 'video_play' : 'link_click',
                post.id,
                { href },
              );
            }}
          >
            {post.body_md}
          </NewsMarkdown>
        </div>
        <div className="velxio-news-footer">
          <button className="velxio-news-ok" onClick={() => close('button')}>
            {t('news.gotIt', 'Got it')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
