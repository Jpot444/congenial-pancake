/*
 * The archive drive — 1.4 TB of files on a disk hanging off the Pi.
 *
 * Two things this screen is honest about, because the drive is:
 *   · it is READ-ONLY and mounted HFS+, so nothing here can be changed, only
 *     played or copied off
 *   · it uses no provider connection at all, which is why it keeps working
 *     when the panel is down or somebody else is streaming
 *
 * It is also owner-only: the box answers 403 for every other profile by
 * design, and this screen says that rather than showing an empty drive.
 */

import { el, clear, gb, hms } from '../ui.js';
import { getArchiveStatus, getArchiveRecent, getArchiveBrowse } from '../api.js';
import { state, isOwner } from '../state.js';
import { posterCard, rowHead, strip, rowBlock } from './cards.js';

let folders = [];
let files = [];
let status = null;
let dir = '';

export async function render(host, app) {
  const root = el('div', 'screen');

  if (!isOwner()) {
    root.append(el('div', 'empty',
      'The archive is only available on the owner profile — this box answers 403 for everyone else.'));
    clear(host).append(root);
    return;
  }

  const profileId = state.profile.id;
  try {
    status = await getArchiveStatus(profileId);
  } catch (err) {
    root.append(el('div', 'empty', `The archive did not answer: ${err.message}`));
    clear(host).append(root);
    return;
  }

  const [browse, recent] = await Promise.all([
    getArchiveBrowse(profileId, dir).catch(() => ({ subdirs: [], items: [] })),
    dir ? Promise.resolve({ items: [] }) : getArchiveRecent(profileId, 24).catch(() => ({ items: [] })),
  ]);
  folders = browse.subdirs || [];
  files = dir ? (browse.items || []) : (recent.items || []);

  root.append(head());

  if (!status.mounted) {
    root.append(el('div', 'empty',
      'The drive is indexed but not mounted. Check that it is plugged in and powered — nothing here will play until it is.'));
  }

  let r = 0;
  if (folders.length) {
    r += 1;
    const row = r;
    const cards = folders.map((folder, c) => folderCard(folder, row, c));
    root.append(rowBlock(rowHead('FOLDERS', { meta: dir || 'Top of the drive' }), strip(cards)));
  }

  if (files.length) {
    r += 1;
    const row = r;
    const cards = files.map((file, c) => posterCard(
      { kind: 'archive', id: file.path, name: file.title, logo: '' },
      { r: row, c, sub: fileMeta(file), kind: 'archivefile' }
    ));
    cards.forEach((card, i) => { card._file = files[i]; });
    root.append(rowBlock(
      rowHead(dir ? 'FILES' : 'RECENTLY ADDED', { meta: 'Plays straight off the drive' }),
      strip(cards)
    ));
  }

  if (!folders.length && !files.length) {
    root.append(el('div', 'empty', status.error
      || 'Nothing indexed here. Run scripts/scan-library.js on the drive.'));
  }

  clear(host).append(root);
}

function head() {
  const wrap = el('div', 'arch-head');
  const left = el('div');
  left.style.minWidth = '0';
  left.append(el('div', 'eyebrow',
    `ARCHIVE DRIVE · ${(status.indexed || 0).toLocaleString()} FILES`));
  left.append(el('div', 'page-title', dir || 'Read-only'));
  wrap.append(left);

  const chips = el('div', 'arch-chips');
  const mount = el('span', 'chip');
  mount.append(el('span', `chip-dot${status.mounted ? '' : ' bad'}`));
  mount.append(status.mounted ? 'Mounted · read-only' : 'Not mounted');
  chips.append(mount);
  chips.append(el('span', 'chip quiet', 'No provider connection used'));
  wrap.append(chips);
  return wrap;
}

function fileMeta(file) {
  const bits = [];
  if (file.year) bits.push(file.year);
  if (file.duration) bits.push(hms(file.duration));
  if (file.size) bits.push(gb(file.size));
  if (file.container) bits.push(`.${file.container}`);
  return bits.join(' · ');
}

function folderCard(folder, r, c) {
  const card = el('div', 'folder');
  card.dataset.r = r;
  card.dataset.c = c;
  card.dataset.kind = 'folder';
  card.dataset.lift = 'tile';
  card._folder = folder;
  const art = el('div', 'folder-art ring');
  art.append(el('span', 'folder-name', folder.name));
  art.append(el('span', 'folder-count', `${folder.count} file${folder.count === 1 ? '' : 's'}`));
  card.append(art);
  return card;
}

export function activate(node, app) {
  if (node.dataset.kind === 'folder') {
    dir = node._folder.dir;
    app.go('archive', { focusRow: 1, focusCol: 0 });
    return;
  }
  const file = node._file;
  if (!file) return;
  if (!status.mounted) {
    app.toast('The drive is not mounted — nothing on it will play until it is.');
    return;
  }
  app.go('vod', {
    kind: 'archive',
    path: file.path,
    title: file.title,
    sub: fileMeta(file),
    eyebrow: 'ARCHIVE',
    resumeKey: `archive:${file.path}`,
    historyKind: 'movie',
    from: 'archive',
  });
}

/** BACK climbs the folder tree before it leaves the screen. */
export function back(app) {
  if (!dir) return false;
  const up = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  dir = up;
  app.go('archive', { focusRow: 1, focusCol: 0 });
  return true;
}
