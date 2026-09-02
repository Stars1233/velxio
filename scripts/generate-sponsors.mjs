#!/usr/bin/env node
//
// Regenerates the sponsor wall in README.md, between the marker comments.
//
//   node scripts/generate-sponsors.mjs [--check]
//
// Current sponsors come from the GraphQL `sponsors` connection, which is
// public data: the plain GITHUB_TOKEN an Actions run already has is enough,
// so this needs no secret of its own.
//
// Past sponsors are not public through the API - `sponsorshipsAsMaintainer`
// wants a `read:user` token. Set SPONSORS_TOKEN to a token with that scope
// and they come from the API too; without it the script falls back to
// reading the public sponsors page. The fallback is markup-dependent by
// nature: if GitHub changes the page it quietly yields nothing, which is
// the right failure - the wall keeps its current sponsors and nothing
// breaks.
//
// The script never fails the build over a network or parsing problem. The
// only fatal error is a README missing its markers.

import { readFile, writeFile } from 'node:fs/promises';

const LOGIN = 'davidmonterocrespo24';
const README = new URL('../README.md', import.meta.url);
const START = '<!-- sponsors:start -->';
const END = '<!-- sponsors:end -->';
const AVATAR = 100; // px requested from GitHub; rendered at 60 for retina

const token = process.env.SPONSORS_TOKEN || process.env.GITHUB_TOKEN || '';
const checkOnly = process.argv.includes('--check');

async function graphql(query) {
  if (!token) return null;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'velxio-sponsors-generator',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    console.warn(`sponsors: GraphQL HTTP ${res.status}`);
    return null;
  }
  const body = await res.json();
  // Partial errors are expected: a token without read:user still answers the
  // public half of the query, so use whatever data came back.
  if (body.errors) console.warn(`sponsors: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data ?? null;
}

// Public. `... on Actor` rather than `... on User` / `... on Organization`
// because the Organization fragment needs read:org and the interface does not.
async function fetchCurrent() {
  const data = await graphql(`query {
    user(login: "${LOGIN}") {
      sponsors(first: 100) {
        nodes { __typename ... on Actor { login avatarUrl(size: ${AVATAR}) url } }
      }
    }
  }`);
  return data?.user?.sponsors?.nodes?.filter(Boolean) ?? [];
}

async function fetchPastFromApi() {
  const data = await graphql(`query {
    user(login: "${LOGIN}") {
      sponsorshipsAsMaintainer(first: 100, includePrivate: false, activeOnly: false) {
        nodes {
          isActive
          sponsorEntity { __typename ... on Actor { login avatarUrl(size: ${AVATAR}) url } }
        }
      }
    }
  }`);
  const nodes = data?.user?.sponsorshipsAsMaintainer?.nodes;
  if (!nodes) return null; // scope missing - let the caller fall back
  return nodes.filter((n) => n && !n.isActive && n.sponsorEntity).map((n) => n.sponsorEntity);
}

async function fetchPastFromPage() {
  const res = await fetch(`https://github.com/sponsors/${LOGIN}`, {
    headers: { 'user-agent': 'velxio-sponsors-generator' },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const heading = html.indexOf('Past sponsors');
  if (heading === -1) return [];
  const section = html.slice(heading, html.indexOf('</remote-pagination>', heading));
  const entry = /data-hovercard-url="\/users\/([^/"]+)\/hovercard"[\s\S]{0,400}?src="([^"]+)"/g;
  const out = [];
  for (const [, login, avatar] of section.matchAll(entry)) {
    out.push({
      login,
      url: `https://github.com/${login}`,
      avatarUrl: avatar.replace(/&amp;/g, '&').replace(/[?&]s=\d+/, `?s=${AVATAR}`),
    });
  }
  return out;
}

const avatars = (people, size) =>
  people
    .map(
      (p) =>
        `  <a href="${p.url}" title="@${p.login}"><img src="${p.avatarUrl}" width="${size}" height="${size}" alt="@${p.login}"></a>`,
    )
    .join('\n');

function render(current, past) {
  if (!current.length && !past.length) {
    return `<p align="center"><em>No public sponsors yet. <a href="https://github.com/sponsors/${LOGIN}">Be the first</a>.</em></p>`;
  }
  const blocks = [];
  if (current.length) {
    blocks.push(`<p align="center">\n${avatars(current, 60)}\n</p>`);
  }
  if (past.length) {
    blocks.push(
      `<p align="center"><sub>Thank you to past sponsors</sub></p>\n<p align="center">\n${avatars(past, 40)}\n</p>`,
    );
  }
  return blocks.join('\n\n');
}

const current = await fetchCurrent();
const past = (await fetchPastFromApi()) ?? (await fetchPastFromPage());
const rendered = render(current, past);

const readme = await readFile(README, 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(`sponsors: README.md is missing the ${START} / ${END} markers`);
  process.exit(1);
}

const updated = `${readme.slice(0, from + START.length)}\n${rendered}\n${readme.slice(to)}`;
if (updated === readme) {
  console.log(`sponsors: up to date (${current.length} current, ${past.length} past)`);
  process.exit(0);
}
if (checkOnly) {
  console.error('sponsors: README.md is stale - run `node scripts/generate-sponsors.mjs`');
  process.exit(1);
}
await writeFile(README, updated);
console.log(`sponsors: README.md updated (${current.length} current, ${past.length} past)`);
