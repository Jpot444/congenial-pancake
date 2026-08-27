/*
 * Small shared makers. Nothing here knows about screens — it is the vocabulary
 * every screen is written in.
 */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Provider artwork always goes through the box's image proxy, as in the portal. */
export const img = (src) => (src ? `/img?u=${encodeURIComponent(src)}` : '');

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
  check: '<path d="M5 13l4 4 10-10"/>',
  heart: '<path d="M12 21s-7.5-4.9-9.3-9.2C1.3 8.4 3.2 5 6.6 5c2 0 3.5 1.2 4.4 2.4l1 1.3 1-1.3C13.9 6.2 15.4 5 17.4 5c3.4 0 5.3 3.4 3.9 6.8C19.5 16.1 12 21 12 21z"/>',
  pin: '<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6z"/><path d="M12 14v7"/>',
  multiview: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/>'
    + '<rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
};

/** Every icon in the product is a 24-box line glyph on these exact terms. */
export function icon(name, size = 24) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;
  svg.style.flex = 'none';
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/* ------------------------------------------------------------- artwork ── */

/*
 * Poster and channel art, with the station-name plate the portal falls back to
 * when a logo is missing or animated. The plate is not a placeholder for a
 * failure — on this provider a good third of the live channels have no usable
 * logo at all, and a legible name at 10 feet beats a broken image every time.
 */

/** Strip the provider's country prefix and quality suffixes for a plate. */
export function plateText(name) {
  return String(name || '')
    .replace(/^[A-Z]{2}\|\s*/i, '')
    .replace(/\b(FHD|UHD|HD|SD|4K|H265|HEVC|RAW)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || String(name || '');
}

/** Two lines beat one long one on a square tile. */
function plateNode(name, className) {
  const words = plateText(name).split(' ').filter(Boolean);
  const node = el('span', className || 'plate');
  if (words.length > 1 && plateText(name).length > 9) {
    node.classList.add('two');
    const half = Math.ceil(words.length / 2);
    node.append(words.slice(0, half).join(' '), el('br'), words.slice(half).join(' '));
  } else {
    node.textContent = plateText(name);
  }
  return node;
}

/**
 * Art with a plate underneath it: the image is only shown once it has loaded,
 * so a slow or dead logo URL never leaves a blank hole where a name should be.
 */
export function artwork(container, logo, name) {
  const plate = plateNode(name);
  container.append(plate);
  if (!logo) return container;
  const image = new Image();
  image.loading = 'lazy';
  image.alt = '';
  image.onload = () => {
    plate.remove();
    container.prepend(image);
  };
  image.src = img(logo);
  return container;
}

/* ------------------------------------------------------------ formats ── */

export function hms(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}

export function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function gb(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function rate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return `${(bytesPerSec / 1024 ** 2).toFixed(2)} MB/s`;
}

export function pct(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** A progress bar in the product's one shape. */
export function bar(percent, tone) {
  const outer = el('span', 'bar');
  const fill = el('span', tone || '');
  fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  outer.append(fill);
  return outer;
}

/* -------------------------------------------------------------- toast ── */

let toastTimer = null;

/** For things the viewer must be told but must not have to acknowledge. */
export function toast(message) {
  const host = document.getElementById('toast');
  if (!host) return;
  clear(host);
  const node = el('div', 'toast', message);
  host.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(host), 4200);
}
