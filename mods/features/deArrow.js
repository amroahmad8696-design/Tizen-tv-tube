import { configRead } from '../config.js';

// DeArrow (https://dearrow.ajay.app/) titles and thumbnails.
//
// YouTube TV renders a tile as soon as it parses the API response, so branding that arrives later never shows.
// To get it in first, the responses that carry tiles (browse, search, next) are held back until the branding
// of their videos is fetched (at most MAX_WAIT_MS), and deArrowItem then applies it while the response is parsed.

const nativeParse = JSON.parse;
const HELD_URL = /\/youtubei\/v1\/(browse|search|next)\b/;
const HELD_EVENTS = ['readystatechange', 'load', 'loadend'];
const MAX_WAIT_MS = 2000;

const branding = new Map();  // videoID -> DeArrow branding response
const inFlight = new Map();  // videoID -> Promise of it

function fetchBranding(videoID) {
  if (branding.has(videoID)) return Promise.resolve(branding.get(videoID));
  if (inFlight.has(videoID)) return inFlight.get(videoID);
  const request = fetch(`https://sponsor.ajay.app/api/branding?videoID=${videoID}`)
    .then(res => res.json())
    .then(data => {
      branding.set(videoID, data);
      return data;
    })
    .catch(() => null)
    .then(data => {
      inFlight.delete(videoID);
      return data;
    });
  inFlight.set(videoID, request);
  return request;
}

function videoIdOf(item) {
  return item?.tileRenderer?.contentId || item?.lockupViewModel?.contentId;
}

function applyBranding(item, videoID, data) {
  if (data.titles?.length > 0) {
    const mostVoted = data.titles.reduce((max, title) => max.votes > title.votes ? max : title);
    item.tileRenderer ?
      item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText = mostVoted.title
      : item.lockupViewModel.metadata.lockupMetadataViewModel.title.content = mostVoted.title;
  }

  if (configRead('enableDeArrowThumbnails') && isVideo(item)) {
    const time = thumbnailTime(data);
    if (time != null) {
      const thumbnails = [
        {
          url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${videoID}&time=${time}`,
          width: 1280,
          height: 640
        }
      ];
      item.tileRenderer ?
        item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = thumbnails
        : item.lockupViewModel.contentImage.thumbnailViewModel.image.sources = thumbnails;
    }
  }
}

function isVideo(item) {
  return item.tileRenderer
    ? !item.tileRenderer.contentType || item.tileRenderer.contentType === 'TILE_CONTENT_TYPE_VIDEO'
    : item.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO';
}

// The video time of the thumbnail to show, or null to keep the original. Like DeArrow's default ("random time"
// fallback), a video without a usable submitted thumbnail gets the frame at the random time the API picked for it.
// Videos the API has no record of keep their thumbnail: the thumbnail server has no frame for them yet.
function thumbnailTime(data) {
  const best = data.thumbnails?.length > 0
    ? data.thumbnails.reduce((max, thumbnail) => max.votes > thumbnail.votes ? max : thumbnail)
    : null;
  if (best && (best.locked || best.votes >= 0)) return best.original ? null : best.timestamp ?? null;
  if (data.randomTime != null && data.videoDuration > 0) return data.randomTime * data.videoDuration;
  return null;
}

/** Applies DeArrow branding to a tile or lockup, right away when it was prefetched, otherwise once it arrives. */
export function deArrowItem(item) {
  if (!configRead('enableDeArrow')) return;
  const videoID = videoIdOf(item);
  if (!videoID) return;
  const apply = data => {
    try {
      if (data) applyBranding(item, videoID, data);
    } catch (e) { }
  };
  if (branding.has(videoID)) apply(branding.get(videoID));
  else fetchBranding(videoID).then(apply);
}

function collectVideoIds(node, ids, depth) {
  if (!node || typeof node !== 'object' || depth > 64) return ids;
  if (Array.isArray(node)) {
    for (const child of node) collectVideoIds(child, ids, depth + 1);
    return ids;
  }
  const tile = node.tileRenderer;
  if (tile?.contentId && (!tile.contentType || tile.contentType === 'TILE_CONTENT_TYPE_VIDEO')) ids.add(tile.contentId);
  const lockup = node.lockupViewModel;
  if (lockup?.contentId && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') ids.add(lockup.contentId);
  for (const key in node) collectVideoIds(node[key], ids, depth + 1);
  return ids;
}

function prefetchFor(xhr) {
  if (xhr.__deArrowPrefetch) return xhr.__deArrowPrefetch;
  let ids = [];
  try {
    const body = xhr.responseType === '' || xhr.responseType === 'text'
      ? nativeParse(xhr.responseText.replace(/^\)\]\}'\s*/, ''))
      : xhr.response;
    ids = [...collectVideoIds(body, new Set(), 0)].filter(id => !branding.has(id));
  } catch (e) { }
  const fetched = Promise.all(ids.map(fetchBranding));
  const timeout = new Promise(resolve => setTimeout(resolve, MAX_WAIT_MS));
  xhr.__deArrowPrefetch = ids.length ? Promise.race([fetched, timeout]) : Promise.resolve();
  return xhr.__deArrowPrefetch;
}

const holders = new WeakMap();  // listener -> its holding wrapper

function holding(listener) {
  if (typeof listener !== 'function') return listener;
  let wrapper = holders.get(listener);
  if (!wrapper) {
    wrapper = function (event) {
      const xhr = this instanceof XMLHttpRequest ? this : event?.target;
      if (!xhr?.__deArrowHold || xhr.readyState !== 4) return listener.apply(this, arguments);
      const self = this, args = arguments;
      prefetchFor(xhr).then(() => listener.apply(self, args));
    };
    wrapper.__deArrowListener = listener;
    holders.set(listener, wrapper);
  }
  return wrapper;
}

function holdTileResponses() {
  const proto = window.XMLHttpRequest?.prototype;
  if (!proto) return;

  const open = proto.open;
  proto.open = function (method, url) {
    this.__deArrowHold = configRead('enableDeArrow') && HELD_URL.test(String(url));
    return open.apply(this, arguments);
  };

  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (type, listener, options) {
    return add.call(this, type, HELD_EVENTS.includes(type) ? holding(listener) : listener, options);
  };
  proto.removeEventListener = function (type, listener, options) {
    const wrapper = HELD_EVENTS.includes(type) && holders.get(listener);
    return remove.call(this, type, wrapper || listener, options);
  };

  for (const type of HELD_EVENTS) {
    const name = 'on' + type;
    let owner = proto;
    while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner);
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor?.get || !descriptor?.set) continue;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const wrapper = descriptor.get.call(this);
        return wrapper?.__deArrowListener || wrapper;
      },
      set(listener) {
        descriptor.set.call(this, holding(listener));
      }
    });
  }
}

holdTileResponses();
