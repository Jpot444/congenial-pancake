/*
 * The cards every browse screen is built from. One definition each, so a
 * poster on Movies and the same poster on Favorites are the same object at the
 * same size with the same ring.
 */

import { el, artwork, plateText, cleanName } from '../ui.js';

/** The wrapper every focusable card shares: row, column, and what it is. */
function focusable(node, { r, c, lift, name, sub, kind }) {
  node.dataset.r = r;
  node.dataset.c = c;
  if (lift) node.dataset.lift = lift;
  if (name) node.dataset.name = name;
  if (sub) node.dataset.sub = sub;
  if (kind) node.dataset.kind = kind;
  return node;
}

/** 320px wide, 16:10 art: a channel, with what is on it underneath. */
export function channelCard(channel, { r, c, now }) {
  const card = focusable(el('div', 'chan-card'), {
    r, c, kind: 'chan', name: cleanName(channel.name), sub: now || '',
  });
  const art = artwork(el('div', 'chan-art ring'), channel.logo, channel.name);
  card.append(art, el('div', 'card-name', cleanName(channel.name)));
  card.append(el('div', 'card-sub', now || (channel.num ? `Channel ${channel.num}` : '')));
  card._item = channel;
  return card;
}

/** A square category tile. */
export function categoryCard(category, { r, c, count }) {
  const card = focusable(el('div', 'cat-card'), {
    r, c, kind: 'cat', lift: 'tile', name: cleanName(category.name), sub: `${count} channels`,
  });
  const art = el('div', 'cat-art ring');
  const words = plateText(category.name).split(' ');
  const plate = el('span', 'plate');
  if (words.length > 1) {
    const half = Math.ceil(words.length / 2);
    plate.append(words.slice(0, half).join(' '), el('br'), words.slice(half).join(' '));
  } else {
    plate.textContent = plateText(category.name);
  }
  art.append(plate);
  card.append(art, el('div', 'card-name', cleanName(category.name)));
  card.append(el('div', 'card-sub', `${count} channels`));
  card._item = category;
  return card;
}

/** The dashed "everything else" tile that ends the categories row. */
export function allCategoriesCard({ r, c, total }) {
  const card = focusable(el('div', 'cat-card'), {
    r, c, kind: 'allcats', lift: 'tile', name: 'All categories', sub: `${total} categories`,
  });
  const art = el('div', 'cat-art all ring');
  const plate = el('span', 'plate');
  plate.append(`ALL ${total}`, el('br'), '›');
  art.append(plate);
  card.append(art, el('div', 'card-name', 'All categories'), el('div', 'card-sub', 'A–Z'));
  return card;
}

/**
 * 236×354 poster. `progress` draws the resume bar across the bottom, which is
 * the only thing that distinguishes a Continue watching card from any other.
 */
export function posterCard(item, { r, c, sub, subClass, progress, kind }) {
  const card = focusable(el('div', 'poster'), {
    r, c, kind: kind || item.kind, name: cleanName(item.name), sub: sub || '',
  });
  const art = artwork(el('div', 'poster-art ring'), item.logo || item.poster, item.name);
  if (Number.isFinite(progress) && progress > 0) {
    const track = el('span', 'poster-progress');
    const fill = el('span');
    fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    track.append(fill);
    art.append(track);
  }
  card.append(art, el('div', 'card-name', cleanName(item.name)));
  if (sub) card.append(el('div', `card-sub ${subClass || ''}`.trim(), sub));
  card._item = item;
  return card;
}

/** A row header: title, optional coloured label, and a right-hand note. */
export function rowHead(title, { label, meta, size } = {}) {
  const head = el('div', 'rowhead');
  const h2 = el('h2', size || 'small', title);
  head.append(h2);
  if (label) head.append(el('span', 'live-label', label));
  if (meta) head.append(el('span', 'meta', meta));
  return head;
}

/** A horizontally scrolling row of cards. */
export function strip(cards, { wide } = {}) {
  const outer = el('div', 'strip');
  const inner = el('div', `strip-inner${wide ? ' wide' : ''}`);
  for (const card of cards) inner.append(card);
  outer.append(inner);
  return outer;
}

export function rowBlock(head, body) {
  const block = el('div', 'rowblock');
  block.append(head, body);
  return block;
}
