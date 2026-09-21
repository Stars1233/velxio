// @vitest-environment jsdom
/**
 * news-announcer-close.test.ts — every showing of a "What's New" post ends
 * in exactly one 'close' event that says how it was closed and for how long
 * it was on screen.
 *
 * Background: the announcement only reported impression / open / clicks, so
 * a post nobody clicked looked the same whether it was read for a minute or
 * dismissed on sight. The close event is what tells those apart, and hidden
 * tab time must not count as reading (a reader who opens a link in a new tab
 * leaves the modal up behind it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NewsAnnouncer } from '../components/layout/NewsAnnouncer';
import { registerNewsSource } from '../lib/newsSource';
import { registerNewsEventSink, type NewsEventDetail, type NewsEventKind } from '../lib/newsEvents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POST = {
  id: 'post-1',
  title: 'Spotlight',
  body_md: 'Body [Try it](https://velxio.dev/example/x "button")',
  publish_date: '2026-09-01',
  expires_date: null,
};

let events: Array<{ kind: NewsEventKind; postId: string; detail?: NewsEventDetail }>;
let root: Root;
let host: HTMLDivElement;
let visibility: DocumentVisibilityState;

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function mountWithPost() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(NewsAnnouncer));
  });
  // FETCH_DELAY_MS, then the source promise.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(document.querySelector('.velxio-news-modal')).not.toBeNull();
}

const closes = () => events.filter((e) => e.kind === 'close');

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  registerNewsSource(async () => POST);
  registerNewsEventSink((kind, postId, detail) => events.push({ kind, postId, detail }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('NewsAnnouncer close event', () => {
  it('reports the button, the visible time and nothing twice', async () => {
    await mountWithPost();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    act(() => {
      (document.querySelector('.velxio-news-ok') as HTMLButtonElement).click();
    });
    // A pagehide after the close must not report a second one.
    window.dispatchEvent(new Event('pagehide'));

    expect(document.querySelector('.velxio-news-modal')).toBeNull();
    expect(closes()).toHaveLength(1);
    const d = closes()[0].detail!;
    expect(closes()[0].postId).toBe('post-1');
    expect(d.via).toBe('button');
    expect(d.durationMs).toBeGreaterThanOrEqual(12_000);
    expect(d.durationMs).toBeLessThan(13_000);
    expect(d.interactions).toBe(0);
  });

  it('does not count time spent in another tab', async () => {
    await mountWithPost();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    setVisibility('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    setVisibility('visible');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    act(() => {
      (document.querySelector('.velxio-news-close') as HTMLButtonElement).click();
    });

    const d = closes()[0].detail!;
    expect(d.via).toBe('x');
    expect(d.durationMs).toBeGreaterThanOrEqual(3_000);
    expect(d.durationMs).toBeLessThan(4_000);
  });

  it('counts link clicks and renders a "button" link as the call to action', async () => {
    await mountWithPost();
    const cta = document.querySelector('a.velxio-news-cta') as HTMLAnchorElement;
    expect(cta).not.toBeNull();
    expect(cta.getAttribute('title')).toBeNull();
    act(() => {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(events.some((e) => e.kind === 'link_click')).toBe(true);
    expect(closes()).toHaveLength(1);
    expect(closes()[0].detail!.via).toBe('escape');
    expect(closes()[0].detail!.interactions).toBe(1);
  });

  it('reports a page left with the modal up', async () => {
    await mountWithPost();
    window.dispatchEvent(new Event('pagehide'));
    expect(closes().map((e) => e.detail!.via)).toEqual(['leave']);
  });

  it('reports a click outside the modal as the backdrop', async () => {
    await mountWithPost();
    act(() => {
      (document.querySelector('.velxio-news-overlay') as HTMLDivElement).click();
    });
    expect(closes().map((e) => e.detail!.via)).toEqual(['backdrop']);
  });
});
