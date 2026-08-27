/*
 * Favorites — everything this profile hearted, split by what it is.
 *
 * Stored on the box against the profile, so a channel hearted from the phone
 * is here on the TV, and the reverse. Nothing on this screen is TV-only state.
 */

import { el, clear } from '../ui.js';
import { state, favorites, loadLibrary, loadEpg, nowOn } from '../state.js';
import { channelCard, posterCard, rowHead, strip, rowBlock } from './cards.js';

let channels = [];
let titles = [];

export async function render(host, app) {
  const list = favorites();
  channels = list.filter((f) => f.item && f.item.kind === 'live').map((f) => f.item);
  titles = list.filter((f) => f.item && f.item.kind !== 'live').map((f) => f.item);

  const root = el('div', 'screen');
  const head = el('div', 'screen-head');
  head.append(el('div', 'eyebrow',
    `FAVORITES · ${list.length} SAVED · ${(state.profile ? state.profile.name : '').toUpperCase()}`));
  head.append(el('div', 'page-title',
    state.profile ? `${state.profile.name}'s shortlist` : 'Shortlist'));
  root.append(head);

  if (!list.length) {
    root.append(el('div', 'empty',
      'Nothing hearted yet — heart a channel from the player, or a title from its page.'));
    clear(host).append(root);
    return;
  }

  let r = 0;
  if (channels.length) {
    r += 1;
    /* Live favourites are worth a now-playing line; that is most of why you
       keep a channel here rather than in a category. */
    const epg = await loadEpg(channels.map((c) => String(c.epgId || c.id)));
    const cards = channels.map((channel, c) => {
      const listing = nowOn(epg.get(String(channel.epgId || channel.id)));
      return channelCard(channel, { r, c, now: listing ? listing.title : '' });
    });
    root.append(rowBlock(rowHead('CHANNELS', { meta: 'Hearted from the player' }), strip(cards)));
  }

  if (titles.length) {
    r += 1;
    const row = r;
    const cards = titles.map((item, c) => posterCard(item, {
      r: row, c, sub: item.kind === 'series' ? 'Series' : (item.rating ? `★ ${item.rating}` : 'Film'),
      kind: item.kind,
    }));
    root.append(rowBlock(rowHead('FILMS & SHOWS', { meta: `${titles.length} saved` }), strip(cards)));
  }

  clear(host).append(root);
}

export function activate(node, app) {
  const item = node && node._item;
  if (!item) return;

  if (item.kind === 'live') {
    app.go('player', { channel: item, from: 'favorites' });
    return;
  }
  if (item.kind === 'series') {
    /* Straight to the show page: the library may not be loaded yet, and the
       show page only needs the id and the name to open. */
    loadLibrary('series');
    app.go('show', { show: item });
    return;
  }
  app.go('vod', {
    kind: 'movie',
    streamId: item.id,
    ext: item.ext || 'mp4',
    title: item.name,
    sub: item.rating ? `★ ${item.rating}` : '',
    eyebrow: 'MOVIE',
    poster: item.logo || '',
    resumeKey: `movie:${item.id}`,
    historyKind: 'movie',
    from: 'favorites',
  });
}
