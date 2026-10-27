/* The Wheelers ride page. No dependencies, no build step.
 *
 * Home (the map, "Where are you going?"), Plan your trip, then name a price
 * and see every driver's offer as it comes: accept one (paying right here
 * when the wallet is short — the driver is confirmed the moment the money
 * lands), decline them all, change the price or cancel. Once a driver is
 * confirmed this same link becomes the live trip map.
 *
 * It holds no booking state of its own: every few seconds it asks the server
 * where the booking is and redraws, so leaving, refreshing or coming back an
 * hour later shows the truth. Fields a newer server adds (priceReason,
 * driversNotified, bidsCloseAt, lastSearch) are all optional:
 * missing, their part of the screen is simply not shown. */
(function () {
  'use strict';
  var W = window.Wheelers;
  var POLL_MS = 3000;        // while bidding: offers should feel instant
  var TRACK_MS = 5000;       // while tracking: a car does not move far in five seconds
  var NUDGE_MS = 120000;     // no offer after two minutes: suggest a higher price
  var HOME_CENTER = { lat: 6.4473, lng: 3.4729 };   // the app's home map, before the phone says where

  var state = null;          // the last thing the server told us
  var shownView = null;      // the view on screen
  var seenOffers = null;     // how many offers there were at the last look — null until the first
  var paying = null;         // the offer being paid for: { key, driverName } — its card stays green
  var declined = null;       // { offers, until }: the offers just declined, shown red for a moment
  var polling = null;
  var busy = false;
  var stopped = false;

  // What only this page knows, never the server.
  var local = {
    plan: false,             // Plan your trip is open (over the home)
    confirming: null,        // { name, fareNgn }: Pay was tapped, the accept is on its way
    endedNote: null,         // "Trip ended": said once on the home after a trip
    cancelledHere: false     // the search was cancelled on this page: no "Search ended" too
  };

  if (!W.takeToken()) { W.fatal('This link is not valid.'); return; }

  function fatal(message) {
    stopped = true;
    clearTimeout(polling);
    shownView = 'fatal';
    document.body.classList.remove('on-home');
    W.fatal(message);
  }

  /* ── storage: never trusted, never in the way ─────────────────────────── */

  function readStore(kind, key) {
    try { var raw = window[kind].getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeStore(kind, key, value) {
    try { window[kind].setItem(key, JSON.stringify(value)); } catch (e) { /* private mode, full, blocked */ }
  }

  /* ── toasts: a queue, so three changes in one poll are three notes ─────── */

  function say(message, tone) {
    var holder = W.$('toasts');
    var node = document.createElement('div');
    node.className = 'toast-item' + (tone ? ' ' + tone : '');
    node.textContent = message;
    holder.appendChild(node);
    while (holder.children.length > 3) holder.removeChild(holder.firstChild);
    setTimeout(function () { node.className += ' leaving'; }, 3400);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 3800);
  }

  /* ── small helpers ────────────────────────────────────────────────────── */

  function setText(selector, text) {
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  /** A small line icon: the paths drawn with the current colour. */
  function icon(paths, extra) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    if (extra) extra(svg);
    return svg;
  }
  var ICON_CLOCK = ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'];
  var ICON_PIN = ['M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z', 'M12 7.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z'];
  var ICON_LOCATE = ['M12 2v3M12 19v3M2 12h3M19 12h3', 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'];
  var ICON_CHEVRON = ['M9 6l6 6-6 6'];

  /** "Timilehin Olowu" → "TO", as the app's avatar shows a name. */
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('');
  }
  function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
  function minutes(n) { return n + ' min'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** "Busy in this area · +₦1,200" (Contract A): nothing when the server sends none. */
  function reasonText(reason) {
    if (!reason || typeof reason.label !== 'string' || !reason.label) return '';
    return reason.label + (Number(reason.extraNgn) > 0 ? ' · +' + W.naira(reason.extraNgn) : '');
  }

  function drawRoute(route) {
    drawStops(route.stopAddresses || []);
    setText('[data-route="pickup"]', route.pickupAddress);
    setText('[data-route="dest"]', route.destAddress);
    setText('[data-route="distance"]', (Number(route.distanceKm) || 0).toFixed(1) + ' km');
    setText('[data-route="time"]', 'About ' + minutes(route.durationMin));
  }

  /** The places on the way, between the pickup row and the destination row of every trip card. */
  var stopsDrawn = null;
  function drawStops(stops) {
    var signature = stops.join('|');
    if (stopsDrawn === signature) return;
    stopsDrawn = signature;
    Array.prototype.forEach.call(document.querySelectorAll('.stop.mid'), function (row) { row.parentNode.removeChild(row); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-route="dest"]'), function (dest) {
      var destRow = dest.closest('.stop');
      if (!destRow) return;
      stops.forEach(function (address, index) {
        // A row as the app's route card draws one: the hollow dot on the rail, "Stop 1", the address.
        var row = el('div', 'route-row stop mid');
        var rail = el('span', 'rail');
        rail.appendChild(el('span', 'dot mid'));
        rail.appendChild(el('span', 'rail-line'));
        row.appendChild(rail);
        var text = el('div', 'route-text');
        text.appendChild(el('span', 'route-label', 'Stop ' + (index + 1)));
        text.appendChild(el('span', 'route-value where', address));
        row.appendChild(text);
        destRow.parentNode.insertBefore(row, destRow);
      });
    });
  }

  /** The figure on a price card: smaller as it gets longer, as the app's shrinks to fit. */
  function drawFigure(id, amount) {
    var text = W.naira(amount);
    var figure = W.$(id);
    figure.textContent = text;
    figure.className = 'figure len-' + Math.min(13, Math.max(2, text.length));
  }
  /** The app's minus and plus (components/rider/price-card.tsx): to the next ₦100, never under the floor. */
  function stepDown(price, floor) { return Math.max(floor, price - (price % 100 || 100)); }
  function stepUp(price) { return price + (100 - (price % 100)); }
  /** "Ilemere Rd, Ikorodu" → "Ilemere Rd". */
  function shortPlace(address) { return String(address || '').split(',')[0].trim(); }

  /* ── analytics: what the rider does here, step by step ─────────────────── */

  // Each step goes to /ride-page/events (the ride_page_* views): a few at a time,
  // every few seconds, and what is left as the rider leaves. Never in the way:
  // a step that cannot be sent is dropped, and nothing waits for it.
  var visitId = 'v' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  var stepNo = 0;
  var unsent = [];
  var sendTimer = null;
  var openedAt = Date.now();

  function track(event, props) {
    try {
      unsent.push({
        seq: ++stepNo,
        event: event,
        phase: state ? state.phase : null,
        rideId: state && state.rideId ? state.rideId : null,
        at: new Date().toISOString(),
        props: props || undefined
      });
      if (unsent.length >= 20) sendSteps(false);
      else if (!sendTimer) sendTimer = setTimeout(function () { sendSteps(false); }, 4000);
    } catch (e) { /* analytics never breaks the page */ }
  }

  function sendSteps(leaving) {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!unsent.length || !window.__wheelersToken) return;
    var batch = unsent.splice(0, 50);
    try {
      fetch('/ride-page/events', {
        method: 'POST',
        // keepalive: the last steps still arrive when the page is being closed.
        keepalive: Boolean(leaving),
        headers: { Authorization: 'Bearer ' + window.__wheelersToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: visitId, events: batch })
      }).catch(function () { /* dropped */ });
    } catch (e) { /* dropped */ }
    if (unsent.length) sendSteps(leaving);
  }

  /**
   * Every request from this page, with a 20-second limit: a request that hangs
   * (a dead connection in WhatsApp's browser) fails with one short line instead
   * of leaving a spinner up for ever. A late answer is dropped; the next poll
   * shows the truth. Only this page: the wallet pages keep Wheelers.api as it is.
   */
  var REQUEST_MS = 20000;
  function api(method, path, body) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject({ status: 0, code: 'TIMEOUT', message: 'No answer. Try again.', body: {} });
      }, REQUEST_MS);
      W.api(method, path, body).then(function (value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function secondsHere() { return Math.round((Date.now() - openedAt) / 1000); }

  /* ── Google Maps: loaded once, only when the server gives a key ───────── */

  var mapsKey = null;
  var mapsBroken = false;
  var mapsLoading = null;
  var HtmlMarker = null;

  // Google calls this when the key is refused (wrong referrer, billing off):
  // every map goes away, and the rest of each screen works as without one.
  window.gm_authFailure = function () {
    mapsBroken = true;
    ['home-map-wrap', 'find-map-wrap', 'map-card'].forEach(function (id) { W.show(W.$(id), false); });
    var offers = document.querySelector('section[data-view="offers"]');
    if (offers) offers.classList.remove('with-map');
  };

  function loadMaps() {
    if (!mapsKey || mapsBroken) return Promise.resolve(null);
    if (mapsLoading) return mapsLoading;
    mapsLoading = new Promise(function (resolve) {
      window.__wheelersMapsReady = function () {
        var g = window.google && window.google.maps;
        if (!g) return resolve(null);
        var libraries = typeof g.importLibrary === 'function'
          ? Promise.all([g.importLibrary('maps'), g.importLibrary('core')]).catch(function () { return null; })
          : Promise.resolve();
        libraries.then(function () {
          try { defineMarker(g); resolve(g); } catch (e) { resolve(null); }
        });
      };
      var script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(mapsKey) + '&loading=async&callback=__wheelersMapsReady';
      script.async = true;
      // The page sends no referrer (it handles money); the key is locked to our
      // web address, so this one request says where it comes from: the origin
      // only, and the link's token was already wiped from the address bar.
      script.referrerPolicy = 'origin';
      script.onerror = function () { resolve(null); };
      document.head.appendChild(script);
    });
    return mapsLoading;
  }

  /** Runs `draw` once the maps are in; never when there is no key or it was refused. */
  function withMaps(draw) {
    loadMaps().then(function (g) {
      if (!g || mapsBroken) return;
      try { draw(g); } catch (e) { /* a map that fails leaves the screen as it is */ }
    });
  }

  /** A marker drawn by the page, shaped as the app's (components/live-map.tsx). */
  function defineMarker(g) {
    if (HtmlMarker) return;
    HtmlMarker = function (map, position, className, onTap) {
      this.pos = position;
      this.div = el('div', 'gm-pin ' + className);
      if (className.indexOf('pin-driver') >= 0) this.div.appendChild(el('span', 'gm-pin-dot'));
      if (onTap) this.div.addEventListener('click', onTap);
      this.setMap(map);
    };
    HtmlMarker.prototype = new g.OverlayView();
    HtmlMarker.prototype.onAdd = function () { this.getPanes().overlayMouseTarget.appendChild(this.div); };
    HtmlMarker.prototype.draw = function () {
      var projection = this.getProjection();
      if (!projection) return;
      var point = projection.fromLatLngToDivPixel(new g.LatLng(this.pos.lat, this.pos.lng));
      if (!point) return;
      this.div.style.left = point.x + 'px';
      this.div.style.top = point.y + 'px';
    };
    HtmlMarker.prototype.onRemove = function () { if (this.div.parentNode) this.div.parentNode.removeChild(this.div); };
    HtmlMarker.prototype.moveTo = function (position) { this.pos = position; this.draw(); };
    HtmlMarker.prototype.setLook = function (className) { this.div.className = 'gm-pin ' + className; };
    /** The car glides to its new fix instead of jumping. */
    HtmlMarker.prototype.glideTo = function (position) {
      var self = this;
      var from = this.pos;
      var started = null;
      if (this.gliding) cancelAnimationFrame(this.gliding);
      if (!from || (from.lat === position.lat && from.lng === position.lng)) return this.moveTo(position);
      function step(now) {
        if (started === null) started = now;
        var t = Math.min(1, (now - started) / 1200);
        self.moveTo({ lat: from.lat + (position.lat - from.lat) * t, lng: from.lng + (position.lng - from.lng) * t });
        self.gliding = t < 1 ? requestAnimationFrame(step) : null;
      }
      this.gliding = requestAnimationFrame(step);
    };
  }

  /** A map as the app draws one: no compass, no rotating or tilting, traffic on. */
  function makeMap(g, node, center, zoom) {
    var map = new g.Map(node, {
      center: center,
      zoom: zoom,
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: 'greedy',
      keyboardShortcuts: false,
      rotateControl: false,
      cameraControl: false,
      tilt: 0,
      heading: 0,
      backgroundColor: '#D4E6D4'
    });
    new g.TrafficLayer().setMap(map);
    return map;
  }

  function routeLine(g, map, points) {
    return new g.Polyline({ path: points, strokeColor: '#FF7700', strokeWeight: 5, strokeOpacity: 1, clickable: false, map: map });
  }

  /** Frames the points, never closer than street level. */
  function frame(g, map, points, padding) {
    if (!points.length) return;
    if (points.length === 1) { map.setCenter(points[0]); map.setZoom(15); return; }
    var bounds = new g.LatLngBounds();
    points.forEach(function (point) { bounds.extend(point); });
    map.fitBounds(bounds, padding);
    g.event.addListenerOnce(map, 'idle', function () { if (map.getZoom() > 16) map.setZoom(16); });
  }

  function validPoint(p) { return p && typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng); }

  /** The trip's places, kept from Set your price for the Finding map (the offers state has addresses only). */
  var PLACES_KEY = 'wheelers.ride.places';
  function rememberPlaces(route, places) {
    if (!route || !places || !validPoint(places.pickup) || !validPoint(places.destination)) return;
    writeStore('sessionStorage', PLACES_KEY, { sig: route.pickupAddress + '|' + route.destAddress, places: places });
  }
  function placesFor(s) {
    if (s.places && validPoint(s.places.pickup) && validPoint(s.places.destination)) return s.places;
    var kept = readStore('sessionStorage', PLACES_KEY);
    if (kept && s.route && kept.sig === s.route.pickupAddress + '|' + s.route.destAddress) return kept.places;
    return null;
  }

  /* ── sheets ───────────────────────────────────────────────────────────── */

  function openSheet(id) {
    closeSheets();
    W.show(W.$('overlay'), true);
    W.show(W.$(id), true);
  }
  function closeSheets() {
    W.show(W.$('sheet-offer'), false);
    W.show(W.$('sheet-pay'), false);
    W.show(W.$('sheet-confirm'), false);
    W.show(W.$('sheet-trip'), false);
    W.show(W.$('sheet-cancel'), false);
    W.show(W.$('overlay'), false);
    if (asking) { var answer = asking; asking = null; answer(false); }
  }

  /**
   * A question in the page's own sheet — never the browser's confirm() box,
   * which says "The page at app.wheelersng.com says" and looks like a warning
   * from somewhere else. Resolves true only on the red button.
   */
  var asking = null;
  function ask(options) {
    return new Promise(function (resolve) {
      openSheet('sheet-confirm');
      W.$('sc-title').textContent = options.title;
      W.$('sc-text').textContent = options.text;
      W.show(W.$('sc-text'), Boolean(options.text));
      W.$('sc-yes').textContent = options.yes;
      W.$('sc-no').textContent = options.no;
      asking = resolve;
      setTimeout(function () { W.$('sc-no').focus(); }, 30);
    });
  }
  W.$('sc-yes').addEventListener('click', function () {
    var answer = asking;
    asking = null;
    closeSheets();
    if (answer) answer(true);
  });
  W.$('sc-no').addEventListener('click', closeSheets);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !W.$('overlay').hidden) W.$('overlay').click();
  });
  /** A sheet put away without finishing it: worth knowing for paying and cancelling. */
  function noteSheetLeft() {
    if (!W.$('sheet-pay').hidden) track('pay_sheet_closed');
    if (!W.$('sheet-cancel').hidden) track('cancel_kept');
  }
  /** The rider backed out of paying for a driver: the server forgets the accept it was holding for the deposit. */
  function keepLooking() {
    api('POST', '/ride-page/keep-looking').then(function (next) {
      if (next && typeof next.phase === 'string' && !busy) apply(next);
    }).catch(function () { /* an older server has no such step: nothing to forget there */ });
  }
  function addStepOpen() { return !W.$('sheet-pay').hidden && !W.$('pay-add').hidden; }

  function sheetPutAway() {
    var leftAdd = addStepOpen();
    noteSheetLeft();
    closeSheets();
    if (leftAdd) keepLooking();
    paying = null;
    payWith = null;
    if (state && state.phase === 'offers' && shownView === 'offers') drawSent(state);
  }
  W.$('overlay').addEventListener('click', sheetPutAway);
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (button) {
    button.addEventListener('click', sheetPutAway);
  });

  /* ── 0 · home: the map and a sheet that slides up and down ─────────────── */

  // Where the phone is: asked once the home is first shown, and again on "Turn on".
  var loc = { state: 'idle', pos: null, place: null, inArea: null };

  function askLocation() {
    if (!navigator.geolocation) { loc.state = 'unavailable'; return; }
    if (loc.state === 'asking') return;
    loc.state = 'asking';
    try {
      navigator.geolocation.getCurrentPosition(function (position) {
        loc.state = 'granted';
        loc.pos = { lat: position.coords.latitude, lng: position.coords.longitude };
        placeMe();
        redrawLocation();
        api('GET', '/ride-page/where?lat=' + encodeURIComponent(loc.pos.lat) + '&lng=' + encodeURIComponent(loc.pos.lng)).then(function (answer) {
          loc.place = answer && answer.place && validPoint(answer.place) && answer.place.address ? answer.place : null;
          loc.inArea = answer && typeof answer.inArea === 'boolean' ? answer.inArea : null;
          // The pickup follows the phone while the rider leaves it alone (as the app's).
          if (loc.place && (!plan.pickup || plan.autoPickup) && !(plan.active === 'pickup' && plan.query)) {
            plan.pickup = loc.place;
            plan.autoPickup = true;
            if (shownView === 'plan') W.$('plan-from').value = loc.place.address;
          }
          redrawLocation();
        }).catch(function (error) {
          if (error.status === 401) fatal(error.message);
        });
      }, function (error) {
        loc.state = error && error.code === 1 ? 'denied' : 'unavailable';
        redrawLocation();
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    } catch (e) {
      loc.state = 'unavailable';
    }
  }

  function redrawLocation() {
    if (shownView === 'idle' && state) drawHome(state, false);
    if (shownView === 'plan') drawPlan();
  }

  W.$('loc-off').addEventListener('click', function () { loc.state = 'idle'; askLocation(); });

  var homeMap = null, meMarker = null, homeCentered = false;

  function drawHomeMap() {
    if (!mapsKey || mapsBroken) { W.show(W.$('home-map-wrap'), false); return; }
    W.show(W.$('home-map-wrap'), true);
    withMaps(function (g) {
      if (shownView !== 'idle') return;
      if (!homeMap) homeMap = makeMap(g, W.$('home-map'), loc.pos || HOME_CENTER, 14);
      placeMe();
    });
  }

  /** Where the phone is, as the app's blue dot; tapping it opens the trip on From. */
  function placeMe() {
    if (!homeMap || !loc.pos || !HtmlMarker) return;
    if (!meMarker) meMarker = new HtmlMarker(homeMap, loc.pos, 'pin-me', function () { openPlan({ field: 'pickup' }); });
    else meMarker.moveTo(loc.pos);
    if (!homeCentered) { homeCentered = true; homeMap.panTo(loc.pos); }
  }

  /* recent places: on this phone only */

  var RECENT_KEY = 'wheelers.ride.recentPlaces';
  function norm(text) { return String(text || '').trim().toLowerCase(); }
  function readRecents() {
    var list = readStore('localStorage', RECENT_KEY);
    return Array.isArray(list) ? list.filter(function (p) { return validPoint(p) && typeof p.address === 'string' && p.address; }).slice(0, 8) : [];
  }
  function saveRecent(place) {
    if (!validPoint(place) || !place.address) return;
    var keep = { lat: place.lat, lng: place.lng, address: place.address, name: place.name || shortPlace(place.address), area: place.area || '' };
    var list = readRecents().filter(function (p) { return norm(p.address) !== norm(place.address); });
    list.unshift(keep);
    writeStore('localStorage', RECENT_KEY, list.slice(0, 8));
  }

  /** A row as the app's place list draws one: the round icon, the name, the area, a chevron. */
  function placeRow(place, iconPaths, ink, onPick) {
    var row = el('button', 'result-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    var round = el('span', 'result-icon' + (ink ? ' ink' : ''));
    round.appendChild(icon(iconPaths));
    row.appendChild(round);
    var words = el('span', 'result-words');
    words.appendChild(el('strong', '', place.title || place.name || shortPlace(place.address)));
    var sub = place.subtitle !== undefined ? place.subtitle : (place.area || '');
    if (sub) words.appendChild(el('span', '', sub));
    row.appendChild(words);
    if (!ink) row.appendChild(icon(ICON_CHEVRON, function (svg) { svg.setAttribute('class', 'result-chevron'); }));
    row.addEventListener('click', onPick);
    return row;
  }

  var homeRecentsSig = null;
  function drawHome(s, changed) {
    // A trip that just ended: said once here, with the way back to the chat.
    W.show(W.$('home-ended'), Boolean(local.endedNote));
    W.$('home-ended-title').textContent = local.endedNote || '';
    var back = W.$('idle-back');
    W.show(back, Boolean(s.chatUrl));
    if (s.chatUrl) back.setAttribute('href', s.chatUrl);

    W.show(W.$('loc-off'), loc.state === 'denied');
    W.show(W.$('not-area'), loc.state !== 'denied' && loc.inArea === false);

    var recents = readRecents().slice(0, 5);
    var holder = W.$('home-recents');
    var recentsSig = JSON.stringify(recents);
    if (recentsSig !== homeRecentsSig) {
      homeRecentsSig = recentsSig;
      holder.innerHTML = '';
    }
    if (!holder.firstChild) recents.forEach(function (place) {
      holder.appendChild(placeRow(place, ICON_CLOCK, false, function () {
        track('place_picked', { field: 'destination', from: 'home_recent' });
        openPlan({ destination: place });
      }));
    });

    if (changed) {
      if (loc.state === 'idle') askLocation();
      drawHomeMap();
    }
    layoutSheet();
  }

  W.$('home-search').addEventListener('click', function () { openPlan({}); });

  /* the sheet: up to book, down to see the map (as the app's, by touch or mouse) */

  var sheet = { open: true, y: 0, closedY: 0, height: 0, scrolls: false };
  var sheetEl = W.$('home-sheet');
  var drag = null;
  var noClickUntil = 0;
  var MAP_PEEK = 40;

  function layoutSheet() {
    if (shownView !== 'idle') return;
    var peek = W.$('home-peek');
    var body = W.$('home-body');
    var topRow = 72;   // as the app leaves room at the top: some map always shows
    var maxSheet = Math.max(240, window.innerHeight - topRow - MAP_PEEK);
    var peekHeight = peek.offsetHeight;
    body.style.maxHeight = Math.max(0, maxSheet - peekHeight) + 'px';
    sheet.height = sheetEl.offsetHeight;
    sheet.closedY = Math.max(0, sheet.height - peekHeight);
    sheet.scrolls = body.scrollHeight > body.clientHeight + 1;
    body.classList.toggle('scrolls', sheet.scrolls);
    // Not while a finger is on it, and not over a slide already going there.
    var target = sheet.open ? 0 : sheet.closedY;
    if (!(drag && drag.moving) && (target !== sheet.y || !sheetEl.style.transform)) setSheetY(target, false);
    else if (!(drag && drag.moving)) W.$('home-map-wrap').style.transform = 'translateY(' + (-Math.max(0, sheet.height - sheet.y) / 2) + 'px)';
  }

  function setSheetY(y, animate) {
    sheet.y = y;
    sheetEl.classList.toggle('gliding', Boolean(animate));
    W.$('home-map-wrap').classList.toggle('gliding', Boolean(animate));
    sheetEl.style.transform = 'translateY(' + y + 'px)';
    // The map's middle stays in the part the sheet leaves uncovered.
    W.$('home-map-wrap').style.transform = 'translateY(' + (-Math.max(0, sheet.height - y) / 2) + 'px)';
  }

  function setSheetOpen(open) {
    sheet.open = open;
    setSheetY(open ? 0 : sheet.closedY, true);
    var handle = W.$('home-handle');
    handle.setAttribute('aria-expanded', String(open));
    handle.setAttribute('aria-label', open ? 'Swipe down to see the map' : 'Swipe up to book a ride');
    W.$('home-body').setAttribute('aria-hidden', String(!open));
  }

  sheetEl.addEventListener('pointerdown', function (event) {
    if (event.button > 0) return;
    // Where the lower part scrolls, swipes there scroll it; the top part still moves the sheet.
    if (sheet.scrolls && W.$('home-body').contains(event.target)) return;
    drag = { id: event.pointerId, startY: event.clientY, fromY: sheet.y, moving: false, lastY: event.clientY, lastT: event.timeStamp, v: 0 };
  });
  sheetEl.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    var dy = event.clientY - drag.startY;
    if (!drag.moving) {
      if (Math.abs(dy) < 10) return;
      drag.moving = true;
      try { sheetEl.setPointerCapture(event.pointerId); } catch (e) { /* older browsers */ }
    }
    var dt = event.timeStamp - drag.lastT;
    if (dt > 0) drag.v = (event.clientY - drag.lastY) / dt * 1000;
    drag.lastY = event.clientY;
    drag.lastT = event.timeStamp;
    setSheetY(Math.min(sheet.closedY, Math.max(0, drag.fromY + dy)), false);
    event.preventDefault();
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    var done = drag;
    drag = null;
    if (!done.moving) return;
    noClickUntil = Date.now() + 400;   // the drag was not a tap on what it started on
    var goDown = done.v > 500 || (done.v > -500 && sheet.y > sheet.closedY / 2);
    setSheetOpen(!goDown);
  }
  sheetEl.addEventListener('pointerup', endDrag);
  sheetEl.addEventListener('pointercancel', endDrag);
  sheetEl.addEventListener('click', function (event) {
    if (Date.now() < noClickUntil) { event.stopPropagation(); event.preventDefault(); }
  }, true);
  W.$('home-handle').addEventListener('click', function () { setSheetOpen(!sheet.open); });
  window.addEventListener('resize', function () { layoutSheet(); });

  /* ── 0b · Plan your trip ──────────────────────────────────────────────── */

  // pickup / destination: { lat, lng, address, name?, area? }, null while being typed.
  var plan = { pickup: null, destination: null, active: 'destination', query: '', results: [], searching: false, searchedFor: null, error: null, seq: 0, autoPickup: false };
  var planTimer = null;
  var PLAN_INPUT = { pickup: 'plan-from', destination: 'plan-to' };

  function openPlan(options) {
    options = options || {};
    plan.destination = options.destination || null;
    if (!plan.pickup && loc.place) { plan.pickup = loc.place; plan.autoPickup = true; }
    plan.query = '';
    plan.results = [];
    plan.error = null;
    W.show(W.$('plan-err'), false);
    plan.active = options.field || (!plan.pickup ? 'pickup' : 'destination');
    W.$('plan-from').value = plan.pickup ? plan.pickup.address : '';
    W.$('plan-to').value = plan.destination ? plan.destination.address : '';
    track('trip_edit_opened', { from: 'home' });
    local.plan = true;
    try { history.pushState({ view: 'plan' }, ''); } catch (e) { /* ignore */ }
    render();
    // The cursor in the field that needs filling (in the same tap, so the keyboard opens).
    if (!(plan.pickup && plan.destination) || options.field) W.$(PLAN_INPUT[plan.active]).focus();
  }

  function leavePlan() {
    if (!local.plan) return;
    local.plan = false;
    clearTimeout(planTimer);
    if (history.state && history.state.view === 'plan') { try { history.back(); } catch (e) { /* ignore */ } }
    render();
  }
  // The phone's own back (Android's button, the iOS swipe) closes Plan your trip, not the page.
  window.addEventListener('popstate', function (event) {
    var toPlan = Boolean(event.state && event.state.view === 'plan');
    if (local.plan && !toPlan) { local.plan = false; clearTimeout(planTimer); render(); return; }
    // A forward swipe onto an old Plan entry: stay on the screen that is true now
    // (the shared handler may already have switched to it).
    if (toPlan && !local.plan) {
      if (shownView && shownView !== 'fatal') W.showOnly(shownView);
      try { history.replaceState(null, ''); } catch (e) { /* ignore */ }
    }
  });
  W.$('plan-back').addEventListener('click', leavePlan);

  var planListSig = null;
  function drawPlan() {
    var typing = plan.query.trim().length > 0;
    ['pickup', 'destination'].forEach(function (field) {
      var input = W.$(PLAN_INPUT[field]);
      W.show(document.querySelector('[data-plan-clear="' + field + '"]'), input.value.length > 0);
      document.querySelector('[data-plan-line="' + field + '"]').classList.toggle('active', plan.active === field);
    });
    var fromActive = plan.active === 'pickup';
    var recents = readRecents();
    var query = norm(plan.query);
    var listedRecents = (typing
      ? recents.filter(function (p) { return norm(p.address).indexOf(query) >= 0 || norm(p.name).indexOf(query) >= 0; })
      : recents).slice(0, 5);
    var results = typing ? plan.results.filter(function (r) {
      return !listedRecents.some(function (p) { return norm(p.address) === norm(r.address); });
    }) : [];

    W.$('plan-heading').textContent = typing ? 'Matching places' : fromActive ? 'Pickup' : listedRecents.length ? 'Your places' : '';
    W.show(W.$('plan-spin'), plan.searching);

    var showError = typing && plan.error && !plan.searching;
    var showNothing = typing && plan.query.trim().length >= 3 && !plan.searching && !plan.error && plan.searchedFor === plan.query.trim() && !listedRecents.length && !results.length;
    var hereRow = fromActive && !typing;
    var sig = JSON.stringify([hereRow, hereRow && loc.place ? loc.place.address : '', showError ? plan.error : '', listedRecents, results, showNothing]);
    var holder = W.$('plan-list');
    if (sig === planListSig) return;
    planListSig = sig;
    holder.innerHTML = '';
    if (hereRow) {
      holder.appendChild(placeRow({
        title: 'Use my current location',
        subtitle: loc.place ? loc.place.address : 'Turn on location to use this'
      }, ICON_LOCATE, true, useMyLocation));
    }
    if (showError) {
      holder.appendChild(el('div', 'notice bad', plan.error));
    }
    listedRecents.forEach(function (place) {
      holder.appendChild(placeRow(place, ICON_CLOCK, false, function () { pickPlace(place); }));
    });
    results.forEach(function (place) {
      holder.appendChild(placeRow(place, ICON_PIN, false, function () { pickPlace(place); }));
    });
    if (showNothing) {
      holder.appendChild(el('p', 'nothing', 'No place found. Check the spelling.'));
    }
  }

  function focusField(field) {
    plan.active = field;
    plan.query = '';
    plan.results = [];
    drawPlan();
    var input = W.$(PLAN_INPUT[field]);
    input.focus();
    try { input.select(); } catch (e) { /* ignore */ }
  }

  function pickPlace(place, notRecent) {
    var field = plan.active;
    var picked = { lat: place.lat, lng: place.lng, address: place.address, name: place.name, area: place.area };
    plan[field] = picked;
    if (field === 'pickup') plan.autoPickup = false;
    W.$(PLAN_INPUT[field]).value = place.address;
    plan.query = '';
    plan.results = [];
    W.show(W.$('plan-err'), false);
    if (!notRecent) saveRecent(picked);
    track('place_picked', { field: field });
    // As the app: on to what is missing; the destination picked last goes straight to the price.
    if (!plan.pickup) return focusField('pickup');
    if (!plan.destination) return focusField('destination');
    if (field === 'destination') return submitPlan();
    focusField('destination');
  }

  function useMyLocation() {
    if (loc.place) { plan.active = 'pickup'; return pickPlace(loc.place, true); }
    // No fix yet: ask for it. An empty From takes the place once it arrives.
    plan.pickup = null;
    plan.autoPickup = true;
    W.$('plan-from').value = '';
    loc.state = 'idle';
    askLocation();
    drawPlan();
  }

  function onPlanFocus() {
    var field = this.getAttribute('data-plan-input');
    if (plan.active === field) return;
    plan.active = field;
    plan.query = '';
    plan.results = [];
    drawPlan();
  }
  function onPlanTyping() {
    var field = this.getAttribute('data-plan-input');
    plan.active = field;
    plan[field] = null;               // typed over: not a place until one is picked
    if (field === 'pickup') plan.autoPickup = false;
    plan.query = this.value;
    plan.error = null;
    W.show(W.$('plan-err'), false);
    clearTimeout(planTimer);
    var query = this.value.trim();
    if (query.length < 3) { plan.searching = false; plan.results = []; plan.seq++; drawPlan(); return; }
    drawPlan();
    planTimer = setTimeout(function () { searchPlaces(field, query); }, 280);
  }
  function onPlanKey(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    var typing = plan.query.trim();
    if (typing && plan.results.length) return pickPlace(plan.results[0]);
    if (!typing) submitPlan();
  }
  ['plan-from', 'plan-to'].forEach(function (id) {
    W.$(id).addEventListener('focus', onPlanFocus);
    W.$(id).addEventListener('input', onPlanTyping);
    W.$(id).addEventListener('keydown', onPlanKey);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-plan-clear]'), function (button) {
    button.addEventListener('click', function () {
      var field = button.getAttribute('data-plan-clear');
      plan[field] = null;
      if (field === 'pickup') plan.autoPickup = false;
      W.$(PLAN_INPUT[field]).value = '';
      focusField(field);
    });
  });

  function searchPlaces(field, query) {
    var seq = ++plan.seq;
    plan.searching = true;
    drawPlan();
    api('GET', '/ride-page/places?field=' + encodeURIComponent(field) + '&q=' + encodeURIComponent(query)).then(function (answer) {
      if (seq !== plan.seq) return;   // a newer search is on its way
      plan.results = ((answer && answer.places) || []).filter(validPoint);
      plan.error = null;
      track('place_searched', { field: field, letters: query.length, results: plan.results.length });
    }).catch(function (error) {
      if (seq !== plan.seq) return;
      if (error.status === 401) return fatal(error.message);
      plan.results = [];
      plan.error = error.message || 'Could not look that up. Try again.';
    }).then(function () {
      if (seq !== plan.seq) return;
      plan.searching = false;
      plan.searchedFor = query;
      if (shownView === 'plan') drawPlan();
    });
  }

  function submitPlan() {
    if (busy) return;
    if (!plan.pickup) return focusField('pickup');
    if (!plan.destination) return focusField('destination');
    var button = W.$('plan-go');
    var pickup = { lat: plan.pickup.lat, lng: plan.pickup.lng, address: plan.pickup.address };
    var destination = { lat: plan.destination.lat, lng: plan.destination.lng, address: plan.destination.address };
    busy = true;
    button.className = 'btn primary busy';
    W.show(W.$('plan-err'), false);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    api('POST', '/ride-page/route', { pickup: pickup, destination: destination, stops: [] }).then(function (next) {
      track('trip_saved', { from: 'plan', distanceKm: next.route ? next.route.distanceKm : 0, suggestedNgn: next.route ? next.route.suggestedFareNgn : 0, stops: 0 });
      if (next.route) rememberPlaces(next.route, { pickup: pickup, destination: destination, stops: [] });
      local.plan = false;
      if (history.state && history.state.view === 'plan') { try { history.back(); } catch (e) { /* ignore */ } }
      apply(next);
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      track('trip_save_failed', { code: error.code || String(error.status) });
      W.$('plan-err').textContent = error.message;
      W.show(W.$('plan-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  }
  W.$('plan-go').addEventListener('click', submitPlan);

  /* ── after a search nobody took: No driver accepted ₦X (Contract E) ─────── */

  var NODRIVER_KEY = 'wheelers.ride.nodriverClosed';
  var noDriverClosed = readStore('sessionStorage', NODRIVER_KEY);
  var ndPicked = null;
  var ndDrawnFor = null;
  var ndOptionsSig = null;

  function lastSearchOf(s) {
    var last = s && s.lastSearch;
    return last && Number(last.offerNgn) > 0 ? last : null;
  }
  function noDriverSig(last) {
    return last.offerNgn + '|' + (last.route ? last.route.pickupAddress + '|' + last.route.destAddress : '');
  }
  /** +5%, +10%, +15%, each to the nearest ₦50, as the app's retry prices. */
  function retryPrices(offer) {
    var seen = {};
    return [1.05, 1.1, 1.15].map(function (raise) { return Math.round((offer * raise) / 50) * 50; })
      .filter(function (price) { if (seen[price] || price <= offer) return false; seen[price] = true; return true; });
  }

  function drawNoDriver(s, changed) {
    var last = lastSearchOf(s);
    if (!last) return;
    var sig = noDriverSig(last);
    var prices = retryPrices(last.offerNgn);
    if (changed || ndDrawnFor !== sig) { ndDrawnFor = sig; ndPicked = prices.length ? prices[0] : null; W.show(W.$('nd-err'), false); }

    W.$('nd-title').textContent = 'No driver accepted ' + W.naira(last.offerNgn);
    var route = last.route;
    W.show(W.$('nd-trip'), Boolean(route));
    if (route) {
      W.$('nd-route').textContent = [shortPlace(route.pickupAddress), shortPlace(route.destAddress)].filter(Boolean).join(' to ');
      W.$('nd-line').textContent = [
        Number(route.distanceKm) > 0 ? Number(route.distanceKm).toFixed(1) + ' km' : '',
        Number(route.durationMin) > 0 ? 'about ' + minutes(Math.max(1, Math.ceil(route.durationMin))) : ''
      ].filter(Boolean).join(' · ');
    }

    W.show(W.$('nd-retry'), prices.length > 0);
    var holder = W.$('nd-options');
    var optionsSig = JSON.stringify([prices, ndPicked]);
    if (optionsSig !== ndOptionsSig) {
      ndOptionsSig = optionsSig;
      holder.innerHTML = '';
    }
    if (!holder.firstChild) prices.forEach(function (price) {
      var option = el('button', 'retry-option' + (price === ndPicked ? ' on' : ''), W.naira(price));
      option.type = 'button';
      option.setAttribute('aria-pressed', String(price === ndPicked));
      option.addEventListener('click', function () { ndPicked = price; drawNoDriver(state, false); });
      holder.appendChild(option);
    });

    var up = W.$('nd-again-up');
    W.show(up, ndPicked !== null);
    up.textContent = ndPicked !== null ? 'Search again at ' + W.naira(ndPicked) : '';
    var same = W.$('nd-again');
    same.textContent = 'Search again at ' + W.naira(last.offerNgn);
    same.className = 'btn ' + (ndPicked !== null ? 'ghost' : 'primary');
  }

  function searchAgain(amount, fromSheet) {
    if (busy || !(amount > 0)) return;
    busy = true;
    track('find_tapped', { amountNgn: amount, again: true });
    api('POST', '/ride-page/search-again', { amountNgn: amount }).then(function (next) {
      if (fromSheet) closeSheets();
      seenOffers = null;
      apply(next);
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      track('find_failed', { code: error.code || String(error.status), again: true });
      var box = W.$(fromSheet ? 'offer-err' : 'nd-err');
      box.textContent = error.message;
      W.show(box, true);
    }).then(function () { busy = false; });
  }
  W.$('nd-again-up').addEventListener('click', function () { if (ndPicked !== null) searchAgain(ndPicked); });
  W.$('nd-again').addEventListener('click', function () { var last = lastSearchOf(state); if (last) searchAgain(last.offerNgn); });
  W.$('nd-other').addEventListener('click', function () { openRestartPrice(); });
  W.$('nd-close').addEventListener('click', function () {
    var last = lastSearchOf(state);
    if (last) { noDriverClosed = noDriverSig(last); writeStore('sessionStorage', NODRIVER_KEY, noDriverClosed); }
    render();
  });

  /* ── 1 · name your price ──────────────────────────────────────────────── */

  var priceDrawnFor = null;

  function drawPrice(s) {
    drawRoute(s.route);
    rememberPlaces(s.route, s.places);
    W.show(W.$('route-edit'), Boolean(s.canEditTrip));
    var back = W.$('price-back');
    W.show(back, Boolean(s.chatUrl));
    if (s.chatUrl) back.setAttribute('href', s.chatUrl);
    var reason = reasonText(s.route.priceReason);
    W.$('price-reason').textContent = reason;
    W.show(W.$('price-reason'), Boolean(reason));
    var signature = s.route.pickupAddress + '|' + s.route.destAddress + '|' + (s.route.stopAddresses || []).join('|') + '|' + s.route.suggestedFareNgn;
    if (priceDrawnFor !== signature) {           // a fresh quote — not every poll, or typing would be wiped
      // The trip changed while they were here: the box starts again from the new suggested price.
      var changed = priceDrawnFor !== null;
      priceDrawnFor = signature;
      W.$('price-suggested').textContent = W.naira(s.route.suggestedFareNgn);
      if (!W.$('price-input').value || changed) {
        // Back from a search: the price they had named. Otherwise the suggested one.
        var start = s.lastOfferNgn && s.lastOfferNgn >= s.minOfferNgn ? s.lastOfferNgn : s.route.suggestedFareNgn;
        W.$('price-input').value = Number(start).toLocaleString('en-NG');
      }
    }
    syncPrice();
  }

  function syncPrice() {
    if (!state || state.phase !== 'price') return;
    var amount = W.parseAmount(W.$('price-input').value);
    var floor = state.minOfferNgn;
    // Set with minus and plus only, as in the app: never under the minimum.
    if (floor > 0 && !(amount >= floor)) {
      amount = floor;
      W.$('price-input').value = Number(floor).toLocaleString('en-NG');
    }
    drawFigure('price-figure', amount);
    W.show(W.$('price-err'), false);

    // The app's words under the price (components/rider/price-card.tsx).
    W.$('price-hint').textContent = amount <= floor ? 'This is the minimum offer for this trip.' : 'Minimum offer: ' + W.naira(floor);
    W.$('price-down').disabled = !(amount > floor);
    var find = W.$('find');
    find.disabled = !(amount >= floor);
    if (!busy) find.textContent = amount > 0 ? 'Find drivers at ' + W.naira(amount) : 'Find drivers';
  }

  // Minus and plus move the price to the next ₦100, as in the app; never under the lowest.
  function stepPrice(up) {
    if (!state || state.phase !== 'price') return;
    var amount = W.parseAmount(W.$('price-input').value) || state.route.suggestedFareNgn;
    var next = up ? stepUp(amount) : stepDown(amount, state.minOfferNgn);
    W.$('price-input').value = Number(next).toLocaleString('en-NG');
    syncPrice();
    track('price_changed', { method: up ? 'plus' : 'minus', amountNgn: next });
  }
  W.$('price-down').addEventListener('click', function () { stepPrice(false); });
  W.$('price-up').addEventListener('click', function () { stepPrice(true); });
  W.$('price-back').addEventListener('click', function () { track('chat_link_tapped', { from: 'price' }); });

  W.$('find').addEventListener('click', function () {
    var button = this;
    if (busy) return;
    busy = true;
    button.className = 'btn primary busy';
    button.textContent = 'Asking drivers…';
    track('find_tapped', { amountNgn: W.parseAmount(W.$('price-input').value), suggestedNgn: state && state.route ? state.route.suggestedFareNgn : 0, minNgn: state ? state.minOfferNgn : 0 });
    api('POST', '/ride-page/find', { amountNgn: W.parseAmount(W.$('price-input').value) }).then(function (next) {
      seenOffers = null;
      apply(next);
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      track('find_failed', { code: error.code || String(error.status) });
      W.$('price-err').textContent = error.message;
      W.show(W.$('price-err'), true);
    }).then(function () {
      busy = false;
      button.className = 'btn primary';
      syncPrice();
    });
  });

  /* ── 2 · the price is out — drivers' offers, live ─────────────────────── */

  var offerSnapshot = null;   // the offers at the last look: { rideId, offerNgn, offers: { key: name } }

  function drawSent(s) {
    drawRoute(s.route);

    // "Ilemere Rd to Ikorodu Garage · your offer ₦12,450", as in the app.
    W.$('offers-route').textContent = [shortPlace(s.route && s.route.pickupAddress), shortPlace(s.route && s.route.destAddress)].filter(Boolean).join(' to ');
    W.$('my-offer').textContent = W.naira(s.offerNgn);

    // The driver being paid for (or asked about) withdrew or sent a new price: that sheet goes.
    var keys = (s.offers || []).map(function (offer) { return offer.key; });
    if (paying && !local.confirming && keys.indexOf(paying.key) < 0) {
      var wasAdding = addStepOpen();
      paying = null;
      if (wasAdding) { closeSheets(); keepLooking(); }
    }
    if (payWith && !W.$('sheet-pay').hidden && keys.indexOf(payWith.offer.key) < 0) { payWith = null; closeSheets(); }
    noteEndedOffers(s);

    // Declined one by one on this page, as in the app: off the list here, the search goes on.
    var offers = (s.offers || []).filter(function (offer) { return !dismissed[offer.key]; });
    var showingDeclined = declined && Date.now() < declined.until;
    if (!showingDeclined) declined = null;
    var list = showingDeclined ? declined.offers : offers;

    var count = offers.length;
    var searching = list.length === 0;
    W.show(W.$('searching'), searching);
    W.$('finding-route').textContent = W.$('offers-route').textContent;
    W.$('finding-offer').textContent = W.naira(s.offerNgn);
    var suggested = s.route && s.route.suggestedFareNgn > 0 ? 'Suggested price ' + W.naira(s.route.suggestedFareNgn) : '';
    W.$('finding-suggested').textContent = suggested;
    W.$('offers-suggested').textContent = suggested;
    W.show(W.$('finding-suggested'), Boolean(suggested));
    W.show(W.$('offers-suggested'), Boolean(suggested));
    var reason = reasonText(s.route && s.route.priceReason);
    W.$('finding-reason').textContent = reason;
    W.show(W.$('finding-reason'), Boolean(reason));
    W.show(W.$('offers-sub'), list.length > 0);
    // As the app: the way back (to change the trip) and the price buttons while finding; the footer once drivers reply.
    W.show(W.$('offers-back'), searching);
    W.show(W.$('offers-foot'), list.length > 0);
    if (count > (seenOffers === null ? 0 : seenOffers)) {
      track('offer_received', { count: count, lowestNgn: offers.length ? Math.min.apply(null, offers.map(function (o) { return o.priceNgn; })) : 0 });
    }
    if (seenOffers !== null && count > seenOffers && !paying) say(count - seenOffers === 1 ? 'New offer' : (count - seenOffers) + ' new offers', 'good');
    seenOffers = count;

    drawOffers(list, showingDeclined, s.offerNgn);
    W.$('offers-title').textContent = showingDeclined
      ? 'Offers declined'
      : count === 0 ? 'Finding drivers' : count === 1 ? '1 driver offer' : count + ' driver offers';
    // The app's steps: drivers reply, then you choose.
    W.show(W.$('offers-steps-2'), count === 0);
    W.show(W.$('offers-steps-3'), count > 0);
    W.show(W.$('decline-all'), count > 0 && !paying && !showingDeclined);

    var back = W.$('back-to-chat');
    W.show(back, Boolean(s.chatUrl));
    if (s.chatUrl) back.setAttribute('href', s.chatUrl);

    drawClock(s);
    drawAuto(s);
    drawFindMap(s, searching);
  }

  /**
   * An offer that went away between two looks, that the rider did not decline
   * or take (the driver withdrew it, or went offline): "Tunde's offer ended".
   * Not when the rider changed the price (every offer goes then), nor when the
   * driver only sent a new price (a new offer from the same driver).
   */
  function noteEndedOffers(s) {
    var now = {};
    (s.offers || []).forEach(function (offer) { now[offer.key] = offer.driverName || ''; });
    var before = offerSnapshot;
    offerSnapshot = { rideId: s.rideId, offerNgn: s.offerNgn, offers: now };
    if (!before || before.rideId !== s.rideId || before.offerNgn !== s.offerNgn) return;
    if (busy || paying || declined || local.confirming) return;
    var names = Object.keys(now).map(function (key) { return norm(now[key]); });
    Object.keys(before.offers).forEach(function (key) {
      if (key in now || dismissed[key]) return;
      var name = before.offers[key];
      if (names.indexOf(norm(name)) >= 0) return;
      say((firstName(name) || 'A driver') + '’s offer ended');
    });
  }

  /* waiting: "N drivers saw your price", the countdown, and a nudge after two minutes (Contract B) */

  var NUDGE_KEY = 'wheelers.ride.nudgeFrom';
  var nudgeFrom = readStore('sessionStorage', NUDGE_KEY) || {};
  function nudgeStart(s) {
    var key = s.rideId + '|' + s.offerNgn;   // a new price starts the two minutes again
    if (!nudgeFrom[key]) {
      nudgeFrom = {};
      nudgeFrom[key] = Date.now();
      writeStore('sessionStorage', NUDGE_KEY, nudgeFrom);
    }
    return nudgeFrom[key];
  }

  function drawClock(s) {
    var notified = Number(s.driversNotified);
    var saw = W.$('drivers-saw');
    W.show(saw, notified > 0);
    saw.textContent = notified === 1 ? '1 driver saw your price' : notified + ' drivers saw your price';

    var closeAt = s.bidsCloseAt ? Date.parse(s.bidsCloseAt) : NaN;
    var countdown = W.$('countdown');
    W.show(countdown, isFinite(closeAt));
    if (isFinite(closeAt)) {
      var left = Math.max(0, Math.round((closeAt - Date.now()) / 1000));
      countdown.textContent = Math.floor(left / 60) + ':' + pad2(left % 60);
    }
    W.show(W.$('search-stats'), notified > 0 || isFinite(closeAt));

    var noOffers = (s.offers || []).length === 0;
    var nudge = noOffers && Date.now() - nudgeStart(s) >= NUDGE_MS;
    W.$('raise').classList.toggle('nudge', nudge);
    W.$('raise-label').textContent = nudge ? 'No offers yet. Raise your price' : 'Raise your offer';
  }

  setInterval(function () {
    if (shownView === 'offers' && state && state.phase === 'offers') drawClock(state);
  }, 1000);

  /* auto-accept (Contract C): automatic on the server whenever the wallet covers the price; the page only says so */

  function drawAuto(s) {
    var covered = typeof s.balanceNgn === 'number' && s.balanceNgn + 0.004 >= (Number(s.offerNgn) || 0) && Number(s.offerNgn) > 0;
    var line = W.$('auto-line');
    W.show(line, covered);
    line.textContent = covered ? 'A driver at ' + W.naira(s.offerNgn) + ' is booked for you' : '';
  }

  /* the Finding map, as the app's matching screen: the trip, and rings in the middle */

  var findMap = null, findPins = [], findLine = null, findSig = null;

  function drawFindMap(s, searching) {
    var wrap = W.$('find-map-wrap');
    var section = wrap.parentNode;
    var want = searching && Boolean(mapsKey) && !mapsBroken;
    W.show(wrap, want);
    section.classList.toggle('with-map', want);
    if (!want) return;
    withMaps(function (g) {
      if (shownView !== 'offers' || wrap.hidden) return;
      var places = placesFor(s);
      var line = s.route && Array.isArray(s.route.line) ? s.route.line.filter(validPoint) : [];
      if (!findMap) findMap = makeMap(g, W.$('find-map'), (places && places.pickup) || loc.pos || HOME_CENTER, 13);
      var sig = JSON.stringify([places, line.length]);
      if (sig === findSig) return;
      findSig = sig;
      findPins.forEach(function (pin) { pin.setMap(null); });
      findPins = [];
      if (findLine) { findLine.setMap(null); findLine = null; }
      if (!places) return;
      if (line.length > 1) findLine = routeLine(g, findMap, line);
      findPins.push(new HtmlMarker(findMap, places.pickup, 'pin-pickup'));
      (places.stops || []).filter(validPoint).forEach(function (stop) { findPins.push(new HtmlMarker(findMap, stop, 'pin-stop')); });
      findPins.push(new HtmlMarker(findMap, places.destination, 'pin-dest'));
      frame(g, findMap, line.length > 1 ? line : [places.pickup].concat((places.stops || []).filter(validPoint), [places.destination]), { top: 70, right: 40, bottom: 70, left: 40 });
    });
  }

  /** One card per offer: white while open, green while paying, red once declined. */
  // The page asks the server every few seconds. Redrawing identical cards made
  // them flash (and replay their slide-in) each time: draw only when something
  // changed, and slide in only the offers not seen before.
  var drawnOffers = null;
  var shownKeys = {};
  var dismissed = {};

  function drawOffers(offers, asDeclined, yoursNgn) {
    var holder = W.$('offer-list');
    var signature = JSON.stringify([offers, asDeclined, yoursNgn, paying && paying.key, busy]);
    if (signature === drawnOffers) return;
    drawnOffers = signature;
    holder.innerHTML = '';
    offers.forEach(function (offer, index) {
      var isPaying = paying && paying.key === offer.key;
      var isNew = !shownKeys[offer.key];
      shownKeys[offer.key] = true;
      // The first card is the dark one, as in the app.
      var card = el('div', 'offer' + (index === 0 && !asDeclined && !isPaying ? ' featured' : '') + (isNew ? ' in' : '') + (asDeclined ? ' declined' : isPaying ? ' paying' : paying ? ' muted' : ''));
      var top = el('div', 'offer-top');
      var name = offer.driverName || 'Driver';
      top.appendChild(el('div', 'avatar', initials(name)));
      var who = el('div', 'who');
      who.appendChild(el('strong', '', name));
      who.appendChild(el('span', '', [
        offer.rating ? Number(offer.rating).toFixed(1) + ' rating' : '',
        offer.vehicle || '',
        offer.etaMin ? minutes(offer.etaMin) + ' away' : ''
      ].filter(Boolean).join(' · ')));
      top.appendChild(who);
      // The price, the plate under it: one row, a small card.
      var side = el('div', 'offer-side');
      side.appendChild(el('div', 'price', W.naira(offer.priceNgn)));
      if (offer.plate) side.appendChild(el('span', 'plate', offer.plate));
      top.appendChild(side);
      card.appendChild(top);
      // Only a driver who took the rider's own price is called out (components/rider/offer-card.tsx).
      var comparison = Math.round(offer.priceNgn) === Math.round(yoursNgn) ? 'Accepted your price' : '';
      if (comparison) {
        var meta = el('div', 'offer-meta');
        meta.appendChild(el('span', 'offer-compare', comparison));
        card.appendChild(meta);
      }

      if (asDeclined) {
        card.appendChild(el('div', 'offer-status', 'Declined'));
      } else if (isPaying) {
        var status = el('div', 'offer-status');
        status.appendChild(el('span', 'spinner'));
        status.appendChild(document.createTextNode('Making payment…'));
        card.appendChild(status);
      } else {
        var actions = el('div', 'offer-actions');
        var decline = el('button', 'btn decline-one', 'Decline');
        decline.type = 'button';
        decline.setAttribute('aria-label', 'Decline the offer from ' + name);
        decline.disabled = Boolean(paying) || busy;
        decline.addEventListener('click', function () {
          track('offer_declined', { priceNgn: offer.priceNgn, rank: index + 1 });
          dismissed[offer.key] = true;
          drawnOffers = null;
          if (state && state.phase === 'offers') drawSent(state);
          // The driver is told and can send a new price (a new offer, a new key).
          api('POST', '/ride-page/decline', { key: offer.key }).then(apply).catch(function () {});
        });
        var accept = el('button', 'btn accept', 'Accept ' + W.naira(offer.priceNgn));
        accept.type = 'button';
        accept.disabled = Boolean(paying) || busy;
        accept.addEventListener('click', function () { acceptOffer(offer); });
        actions.appendChild(decline);
        actions.appendChild(accept);
        card.appendChild(actions);
      }
      holder.appendChild(card);
    });
  }

  /* accept → "Pay ₦X from your wallet?" (Contract D) → Confirming your driver */

  function acceptOffer(offer) {
    if (busy || paying) return;
    var list = (state && state.offers) || [];
    var rank = list.map(function (o) { return o.key; }).indexOf(offer.key) + 1;
    track('accept_tapped', { priceNgn: offer.priceNgn, rank: rank, offers: list.length });
    openPaySheet(offer);
  }

  /** XLM for a naira price at the page's rate — what the rider is shown (the server sizes the real payment). */
  function xlmFor(priceNgn, xlm) { return priceNgn / xlm.ngnPerXlm; }
  function xlmText(amount) { return (Math.ceil(amount * 100) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' XLM'; }

  var payWith = null;   // { offer, method, amountXlm }

  function showPayPart(part) {
    W.show(W.$('pay-ask'), part === 'ask');
    W.show(W.$('pay-add'), part === 'add');
  }

  function openPaySheet(offer) {
    var xlm = state && state.xlm && state.xlm.ngnPerXlm > 0 ? state.xlm : null;
    W.$('pay-title').textContent = 'Pay ' + W.naira(offer.priceNgn) + ' from your wallet?';
    payWith = { offer: offer, method: 'ngn', amountXlm: xlm ? xlmFor(offer.priceNgn, xlm) : 0 };
    // Naira or XLM, when the rider has a Stellar wallet and there is a price for it.
    W.show(W.$('pay-options'), Boolean(xlm));
    W.show(W.$('pw-rate'), Boolean(xlm));
    if (xlm) {
      var xlmCovers = payWith.amountXlm <= xlm.spendableXlm;
      W.$('pw-ngn-balance').textContent = 'Balance ' + W.naira(state.balanceNgn);
      W.$('pw-ngn-amount').textContent = W.naira(offer.priceNgn);
      W.$('pw-xlm-balance').textContent = xlmCovers ? 'Balance ' + xlmText(xlm.balanceXlm) : 'You can spend ' + xlmText(xlm.spendableXlm);
      W.$('pw-xlm-amount').textContent = xlmText(payWith.amountXlm);
      W.$('pw-xlm').disabled = !xlmCovers;
      W.$('pw-rate').textContent = '1 XLM ≈ ' + W.naira(xlm.ngnPerXlm);
    }
    pickMethod('ngn');
    showPayPart('ask');
    openSheet('sheet-pay');
  }

  function pickMethod(method) {
    if (!payWith) return;
    payWith.method = method;
    var xlm = method === 'xlm';
    W.$('pw-ngn').className = 'pay-option' + (xlm ? '' : ' on');
    W.$('pw-xlm').className = 'pay-option' + (xlm ? ' on' : '');
    W.$('pw-ngn').setAttribute('aria-checked', String(!xlm));
    W.$('pw-xlm').setAttribute('aria-checked', String(xlm));
    W.$('pay-go').textContent = xlm ? 'Pay ' + xlmText(payWith.amountXlm) : 'Pay ' + W.naira(payWith.offer.priceNgn);
  }
  W.$('pw-ngn').addEventListener('click', function () { pickMethod('ngn'); });
  W.$('pw-xlm').addEventListener('click', function () { if (!this.disabled) pickMethod('xlm'); });
  W.$('pay-go').addEventListener('click', function () {
    if (!payWith) return;
    var chosen = payWith;
    payWith = null;
    track('pay_method_chosen', { method: chosen.method });
    closeSheets();
    payFor(chosen.offer, chosen.method);
  });

  function payFor(offer, method) {
    if (busy || paying) return;
    busy = true;
    paying = { key: offer.key, driverName: offer.driverName || 'your driver' };
    local.confirming = { name: offer.driverName || '', fareNgn: offer.priceNgn };
    render();
    api('POST', '/ride-page/accept', { key: offer.key, method: method }).then(function (next) {
      busy = false;
      paying = null;
      local.confirming = null;
      apply(next);
    }).catch(function (error) {
      busy = false;   // before the redraw: the offers come back live, not greyed out
      local.confirming = null;
      if (error.status === 401) return fatal(error.message);
      // The poll already found the ride confirmed (or ended) while this was on its way.
      if (!state || state.phase !== 'offers') { paying = null; return; }
      if (error.code === 'WALLET_SHORT') {
        track('wallet_short_shown', { shortNgn: error.body && error.body.shortNgn ? error.body.shortNgn : 0 });
        render();
        return openAdd(offer, error.body);
      }
      // Refused: back to the offers, with one line saying why.
      track('accept_failed', { code: error.code || String(error.status) });
      paying = null;
      render();
      say(error.message, 'bad');
    }).then(function () { busy = false; });
  }

  /** Short: the account to send to. The deposit landing confirms the driver, with no further tap. */
  function openAdd(offer, info) {
    W.$('add-title').textContent = 'Add ' + W.naira(info.sendNgn);
    W.$('add-sub').textContent = 'Fare ' + W.naira(info.fareNgn) + ' · wallet ' + W.naira(info.balanceNgn);
    var account = info.account;
    W.show(W.$('pay-wait-account'), !account);
    W.$('pay-bank').textContent = account ? account.bankName : '—';
    W.$('pay-number').textContent = account ? account.accountNumber : '—';
    W.$('pay-name').textContent = account ? account.accountName : '—';
    W.$('pay-copy').onclick = function () {
      if (!account) return;
      track('account_copied');
      W.copy(account.accountNumber).then(function () { W.$('pay-copy').textContent = 'Copied'; setTimeout(function () { W.$('pay-copy').textContent = 'Copy'; }, 1800); });
    };
    showPayPart('add');
    openSheet('sheet-pay');
  }

  function drawConfirming() {
    var c = local.confirming || {};
    W.$('cf-who').textContent = [c.name, c.fareNgn ? W.naira(c.fareNgn) : ''].filter(Boolean).join(' · ');
  }

  /* decline all: every card turns red, then the list clears — the search goes on */

  W.$('decline-all').addEventListener('click', function () {
    if (busy || !state || state.phase !== 'offers') return;
    var count = (state.offers || []).length;
    ask({
      title: count === 1 ? 'Decline this offer?' : 'Decline all ' + count + ' offers?',
      text: '',
      yes: count === 1 ? 'Decline offer' : 'Decline all',
      no: 'Keep offers'
    }).then(function (yes) { if (yes) declineAll(); });
  });

  function declineAll() {
    if (busy || !state || state.phase !== 'offers') return;
    busy = true;
    var shownOffers = (state.offers || []).slice();
    api('POST', '/ride-page/decline-all').then(function (next) {
      declined = { offers: shownOffers, until: Date.now() + 1800 };
      track('decline_all', { count: shownOffers.length });
      apply(next);
      setTimeout(function () { if (state && state.phase === 'offers' && shownView === 'offers') drawSent(state); }, 1900);
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      say(error.message, 'bad');
    }).then(function () { busy = false; });
  }

  /* change the bid — or, after nobody took it, search again at a new one */

  var offerMode = 'change';   // 'change': the live search; 'restart': search again (No driver accepted)

  function sheetBase() {
    if (offerMode === 'restart') { var last = lastSearchOf(state); return last ? last.offerNgn : 0; }
    return state ? state.offerNgn : 0;
  }
  function sheetFloor() { return offerMode === 'restart' ? 0 : (state ? state.minOfferNgn || 0 : 0); }

  /** The change-price sheet, starting at the current offer plus `raiseBy` (as the app's + ₦200 / + ₦500 / Other). */
  function openChangePrice(raiseBy) {
    if (!state || state.phase !== 'offers') return;
    offerMode = 'change';
    fillOfferSheet(state.offerNgn + (raiseBy || 0));
  }
  function openRestartPrice() {
    var last = lastSearchOf(state);
    if (!last) return;
    offerMode = 'restart';
    track('price_sheet_opened', { from: 'search_again' });
    fillOfferSheet(ndPicked || last.offerNgn);
  }
  function fillOfferSheet(start) {
    var base = sheetBase();
    W.$('offer-input').value = Number(start).toLocaleString('en-NG');
    W.$('offer-current').textContent = W.naira(base);
    W.$('offer-keep').textContent = 'Keep ' + W.naira(base);
    var route = offerMode === 'restart' ? (lastSearchOf(state) || {}).route : state.route;
    var suggested = route && route.suggestedFareNgn > 0 ? 'Suggested price ' + W.naira(route.suggestedFareNgn) : '';
    W.$('offer-suggested').textContent = suggested;
    W.show(W.$('offer-suggested'), Boolean(suggested));
    W.show(W.$('offer-err'), false);
    syncOfferSheet();
    openSheet('sheet-offer');
  }
  /** The figure, the minimum line and the button follow the price: "Update price to ₦X". */
  function syncOfferSheet() {
    var amount = W.parseAmount(W.$('offer-input').value);
    var floor = sheetFloor();
    drawFigure('offer-figure', amount);
    W.$('offer-down').disabled = !(amount > floor);
    W.show(W.$('offer-min'), floor > 0);
    W.$('offer-min').textContent = amount <= floor ? 'This is the minimum offer for this trip.' : 'Minimum offer: ' + W.naira(floor);
    W.$('offer-save').textContent = (offerMode === 'restart' ? 'Search again at ' : 'Update price to ') + W.naira(amount);
  }
  function stepOffer(up) {
    if (!state) return;
    var amount = W.parseAmount(W.$('offer-input').value) || sheetBase();
    W.$('offer-input').value = Number(up ? stepUp(amount) : stepDown(amount, sheetFloor())).toLocaleString('en-NG');
    syncOfferSheet();
  }
  W.$('offer-down').addEventListener('click', function () { stepOffer(false); });
  W.$('offer-up').addEventListener('click', function () { stepOffer(true); });
  W.$('change-offer').addEventListener('click', function () { track('price_sheet_opened', { from: 'change_my_price' }); openChangePrice(0); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-raise]'), function (button) {
    button.addEventListener('click', function () {
      var by = Number(button.getAttribute('data-raise')) || 0;
      track('raise_tapped', { by: by, nudged: W.$('raise').classList.contains('nudge') });
      openChangePrice(by);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-add]'), function (button) {
    button.addEventListener('click', function () {
      var amount = W.parseAmount(W.$('offer-input').value) || sheetBase();
      W.$('offer-input').value = Number(amount + Number(button.getAttribute('data-add'))).toLocaleString('en-NG');
      syncOfferSheet();
    });
  });
  W.$('offer-reset').addEventListener('click', function () {
    if (!state) return;
    W.$('offer-input').value = Number(Math.max(sheetFloor(), sheetBase())).toLocaleString('en-NG');
    syncOfferSheet();
  });

  W.$('offer-save').addEventListener('click', function () {
    var button = this;
    var amount = W.parseAmount(W.$('offer-input').value);
    if (busy) return;
    if (offerMode === 'restart') return searchAgain(amount, true);
    if (state && amount === state.offerNgn) return closeSheets();
    busy = true;
    button.className = 'btn primary busy';
    var before = state ? state.offerNgn : 0;
    api('POST', '/ride-page/offer', { amountNgn: amount }).then(function (next) {
      closeSheets();
      apply(next);
      track('price_updated', { fromNgn: before, toNgn: amount });
      say('Offer updated to ' + W.naira(amount) + '. Drivers notified.', 'good');
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      track('price_update_failed', { code: error.code || String(error.status) });
      W.$('offer-err').textContent = error.message;
      W.show(W.$('offer-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  });

  /* cancel: why, as the app asks (app/rider-cancel.tsx) — nothing chosen for them */

  var CANCEL_REASONS = [
    "It's taking too long to find a driver",
    'The prices are too high',
    'Wrong pickup or destination',
    'I found another ride',
    'My plans changed',
    'Other reason'
  ];
  var OTHER = 'Other reason';
  var cancelReason = null;

  function drawReasons() {
    var holder = W.$('cancel-reasons');
    holder.innerHTML = '';
    CANCEL_REASONS.forEach(function (reason) {
      var chosen = cancelReason === reason;
      var row = el('button', 'reason' + (chosen ? ' on' : ''));
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(chosen));
      row.appendChild(el('span', 'radio'));
      row.appendChild(el('span', 'reason-text', reason));
      row.addEventListener('click', function () {
        track('cancel_reason_picked', { reason: reason });
        cancelReason = reason;
        drawReasons();
        W.show(W.$('cancel-other-field'), reason === OTHER);
        if (reason === OTHER) setTimeout(function () { W.$('cancel-other').focus(); }, 30);
        syncCancel();
      });
      holder.appendChild(row);
    });
  }
  // As the app: their own words are optional; the button reads "Choose a reason" until one is picked.
  function syncCancel() {
    var button = W.$('cancel-yes');
    button.disabled = !cancelReason;
    button.textContent = cancelReason ? 'Cancel search' : 'Choose a reason';
    W.show(W.$('cancel-err'), false);
  }
  W.$('cancel-other').addEventListener('input', syncCancel);

  W.$('cancel-search').addEventListener('click', function () {
    if (busy) return;
    cancelReason = null;
    W.$('cancel-other').value = '';
    W.show(W.$('cancel-other-field'), false);
    drawReasons();
    syncCancel();
    track('cancel_opened');
    openSheet('sheet-cancel');
  });

  W.$('cancel-yes').addEventListener('click', function () {
    if (busy || !cancelReason) return;
    var button = this;
    busy = true;
    button.className = 'btn danger busy';
    var body = { reason: cancelReason };
    var words = W.$('cancel-other').value.trim();
    if (cancelReason === OTHER && words) body.detail = words;
    api('POST', '/ride-page/cancel', body).then(function (next) {
      track('cancel_confirmed', body);
      closeSheets();
      local.cancelledHere = true;
      apply(next);
      say('Search cancelled. Nothing was charged.');
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      track('cancel_failed', { code: error.code || String(error.status) });
      W.$('cancel-err').textContent = error.message;
      W.show(W.$('cancel-err'), true);
    }).then(function () { busy = false; button.className = 'btn danger'; });
  });

  /* back from the search, to change the trip or the price */

  W.$('offers-back').addEventListener('click', function () {
    if (busy || !state || state.phase !== 'offers') return;
    var count = (state.offers || []).length;
    track('edit_trip_back_tapped', { offers: count });
    ask({
      title: 'Change your trip?',
      text: (count ? 'The ' + (count === 1 ? 'offer' : count + ' offers') + ' you have go away and drivers' : 'Drivers') + ' stop seeing this request. You set the trip and your price again. Nothing is charged.',
      yes: 'Change trip',
      no: 'Keep looking'
    }).then(function (yes) {
      track(yes ? 'edit_trip_back_confirmed' : 'edit_trip_back_kept');
      if (!yes) return;
      busy = true;
      api('POST', '/ride-page/edit-trip').then(function (next) {
        apply(next);
      }).catch(function (error) {
        if (error.status === 401) return fatal(error.message);
        say(error.message, 'bad');
      }).then(function () { busy = false; });
    });
  });

  /* change the trip: type a place, pick it from the list (the chat's own lookup) */

  var trip = null;          // { pickup, destination, stops: [] } — each { lat, lng, address }, null while being typed
  var searchTimer = null;
  var searchSeq = 0;

  function openTrip() {
    if (!state || state.phase !== 'price' || !state.places) return;
    trip = {
      pickup: state.places.pickup,
      destination: state.places.destination,
      stops: (state.places.stops || []).slice()
    };
    W.$('trip-pickup').value = trip.pickup.address;
    W.$('trip-dest').value = trip.destination.address;
    drawTripStops();
    clearPlaces();
    W.show(W.$('trip-err'), false);
    syncTrip();
    track('trip_edit_opened');
    openSheet('sheet-trip');
  }
  W.$('route-edit').addEventListener('click', openTrip);

  /** The stops on the way: each can be taken off (adding one is done in the chat). */
  function drawTripStops() {
    var holder = W.$('trip-stops');
    holder.innerHTML = '';
    trip.stops.forEach(function (stop, index) {
      var row = el('div', 'trip-field stop-row');
      row.appendChild(el('span', 'trip-dot mid'));
      row.appendChild(el('span', 'stop-text', 'Stop ' + (index + 1) + ': ' + stop.address));
      var remove = el('button', 'stop-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove stop ' + (index + 1));
      remove.addEventListener('click', function () {
        track('stop_removed');
        trip.stops.splice(index, 1);
        drawTripStops();
        syncTrip();
      });
      row.appendChild(remove);
      holder.appendChild(row);
    });
  }

  function syncTrip() {
    W.$('trip-save').disabled = !(trip && trip.pickup && trip.destination);
  }

  function clearPlaces() {
    W.$('place-list').innerHTML = '';
  }

  function onTripTyping() {
    var input = this;
    var field = input.getAttribute('data-field');
    trip[field] = null;              // typed over: not a place until one is picked
    syncTrip();
    W.show(W.$('trip-err'), false);
    clearTimeout(searchTimer);
    var query = input.value.trim();
    if (query.length < 3) { clearPlaces(); return; }
    searchTimer = setTimeout(function () { findPlaces(field, query); }, 350);
  }
  W.$('trip-pickup').addEventListener('input', onTripTyping);
  W.$('trip-dest').addEventListener('input', onTripTyping);

  function findPlaces(field, query) {
    var seq = ++searchSeq;
    var holder = W.$('place-list');
    holder.innerHTML = '';
    var looking = el('div', 'place-status');
    looking.appendChild(el('span', 'spinner'));
    looking.appendChild(document.createTextNode('Looking for places…'));
    holder.appendChild(looking);
    api('GET', '/ride-page/places?field=' + encodeURIComponent(field) + '&q=' + encodeURIComponent(query)).then(function (answer) {
      if (seq !== searchSeq) return;   // a newer search is on its way
      holder.innerHTML = '';
      var places = (answer && answer.places) || [];
      track('place_searched', { field: field, letters: query.length, results: places.length });
      if (!places.length) {
        holder.appendChild(el('div', 'place-status', 'No place found. Add the area or a landmark, e.g. "Shoprite, Ikeja".'));
        return;
      }
      places.forEach(function (place) {
        var option = el('button', 'place');
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.appendChild(el('strong', '', place.name || place.address));
        if (place.area) option.appendChild(el('span', '', place.area));
        option.addEventListener('click', function () {
          track('place_picked', { field: field });
          trip[field] = { lat: place.lat, lng: place.lng, address: place.address };
          saveRecent(place);
          W.$(field === 'pickup' ? 'trip-pickup' : 'trip-dest').value = place.address;
          clearPlaces();
          syncTrip();
        });
        holder.appendChild(option);
      });
    }).catch(function (error) {
      if (seq !== searchSeq) return;
      if (error.status === 401) return fatal(error.message);
      holder.innerHTML = '';
      holder.appendChild(el('div', 'place-status', error.message || 'Could not look that up. Try again.'));
    });
  }

  W.$('trip-save').addEventListener('click', function () {
    if (busy || !trip || !trip.pickup || !trip.destination) return;
    var button = this;
    busy = true;
    button.className = 'btn primary busy';
    button.textContent = 'Working out the new price…';
    api('POST', '/ride-page/route', { pickup: trip.pickup, destination: trip.destination, stops: trip.stops }).then(function (next) {
      closeSheets();
      apply(next);
      track('trip_saved', { distanceKm: next.route ? next.route.distanceKm : 0, suggestedNgn: next.route ? next.route.suggestedFareNgn : 0, stops: trip.stops.length });
    }).catch(function (error) {
      if (error.status === 401) return fatal(error.message);
      track('trip_save_failed', { code: error.code || String(error.status) });
      W.$('trip-err').textContent = error.message;
      W.show(W.$('trip-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; button.textContent = 'Save trip'; });
  });

  /* ── 3a · Driver found (Contract E): once per ride, then the trip ──────── */

  var FOUND_KEY = 'wheelers.ride.found.';
  var foundSeen = {};

  function foundId(s) { return s.rideId || (s.trip && s.trip.tripId) || ''; }
  function seenFound(id) {
    if (!id || foundSeen[id]) return true;
    try { return localStorage.getItem(FOUND_KEY + id) === '1'; } catch (e) { return false; }
  }
  function markFound(id) {
    if (!id) return;
    foundSeen[id] = true;
    try { localStorage.setItem(FOUND_KEY + id, '1'); } catch (e) { /* this visit still remembers */ }
  }
  function showFound(s) {
    var status = s.trip && s.trip.status;
    // Opened mid-trip, or with the driver already outside: straight to the trip.
    if (status === 'IN_PROGRESS' || status === 'ARRIVED') { markFound(foundId(s)); return false; }
    return !seenFound(foundId(s));
  }

  function drawFound(s) {
    var driver = s.driver || {};
    var name = (driver.name || '').trim();
    var first = firstName(name);
    W.$('fd-initial').textContent = name ? initials(name) : 'W';
    W.$('fd-title').textContent = first ? first + ' is your driver' : 'Your driver is confirmed';
    var rated = Number(driver.rating) > 0;
    W.show(W.$('fd-rating'), rated);
    W.$('fd-rating').textContent = rated ? Number(driver.rating).toFixed(1) + ' rating' : '';
    var fare = driver.fareNgn || s.offerNgn;
    W.show(W.$('fd-price'), fare > 0);
    W.$('fd-fare').textContent = W.naira(fare);
    W.$('fd-paid').textContent = s.paidWithXlm ? 'Paid with XLM' : 'Paid from your wallet';

    var eta = driver.etaMin || (s.trip && s.trip.etaMin) || null;
    var rows = [];
    if (driver.vehicle) rows.push({ label: 'Car', value: driver.vehicle });
    if (driver.plate) rows.push({ label: 'Plate number', value: driver.plate, plate: true });
    if (eta) rows.push({ label: 'Arrives in', value: eta === 1 ? '1 minute' : eta + ' minutes' });
    var holder = W.$('fd-details');
    holder.innerHTML = '';
    rows.forEach(function (row) {
      var line = el('div', 'detail-row');
      line.appendChild(el('span', 'detail-label', row.label));
      line.appendChild(el(row.plate ? 'span' : 'strong', row.plate ? 'plate detail-plate' : 'detail-value', row.value));
      holder.appendChild(line);
    });
    W.show(holder, rows.length > 0);
  }

  W.$('fd-track').addEventListener('click', function () {
    if (!state) return;
    track('track_driver_tapped');
    markFound(foundId(state));
    render();
  });

  /* ── 3 · confirmed → live trip ────────────────────────────────────────── */

  var tripMap = null, carMarker = null, tripLine = null, tripPins = [], tripFor = null, followCar = true, mapFitted = false;

  /** A new ride on the same page: the last one's pins, road and car go, and the map frames afresh. */
  function clearTripMap() {
    tripPins.forEach(function (pin) { pin.setMap(null); });
    tripPins = [];
    if (tripLine) { tripLine.setMap(null); tripLine = null; }
    if (carMarker) { if (carMarker.gliding) cancelAnimationFrame(carMarker.gliding); carMarker.setMap(null); carMarker = null; }
    mapFitted = false;
    followCar = true;
  }

  var TRIP_COPY = {
    DRIVER_ASSIGNED: ['Ride confirmed', 'Your driver is ', 'on the way'],
    DRIVER_EN_ROUTE: ['Ride confirmed', 'Your driver is ', 'on the way'],
    ARRIVED: ['Your driver is here', 'Your driver has ', 'arrived'],
    IN_PROGRESS: ['Trip in progress', 'You’re ', 'on your way']
  };

  function drawTrip(t) {
    var copy = TRIP_COPY[t.status] || TRIP_COPY.DRIVER_ASSIGNED;
    W.$('trip-eyebrow').textContent = copy[0];

    var position = validPoint(t.driverPosition) ? t.driverPosition : null;
    var badge = W.$('map-eta');
    var badgeText = t.status === 'ARRIVED' ? 'Driver is outside'
      : t.etaMin ? (t.status === 'IN_PROGRESS' ? 'Arriving in ' : 'Pickup in ') + minutes(t.etaMin) : '';
    badge.textContent = badgeText;
    W.show(badge, Boolean(badgeText));

    var stale = W.$('map-stale');
    var showStale = Boolean(position) && !t.positionFresh && t.positionAgeSeconds !== null && t.positionAgeSeconds !== undefined;
    W.show(stale, showStale);
    if (showStale) stale.textContent = 'Location from ' + Math.max(1, Math.round(t.positionAgeSeconds / 60)) + ' min ago';
    if (!position) { W.show(stale, true); stale.textContent = 'Waiting for location…'; }

    // No key, or Google refused it: the card below still says everything.
    if (!mapsKey || mapsBroken || !validPoint(t.pickup) || !validPoint(t.destination)) { W.show(W.$('map-card'), false); return; }
    W.show(W.$('map-card'), true);

    withMaps(function (g) {
      if (shownView !== 'confirmed') return;
      if (!tripMap) {
        tripMap = makeMap(g, W.$('map'), t.pickup, 14);
        // Once they move the map themselves, stop dragging it back to the car.
        tripMap.addListener('dragstart', function () { followCar = false; });
      }
      var rideKey = (state && foundId(state)) || (t.tripId || '');
      if (tripFor !== rideKey) {
        clearTripMap();
        tripFor = rideKey;
        tripPins = [new HtmlMarker(tripMap, t.pickup, 'pin-pickup'), new HtmlMarker(tripMap, t.destination, 'pin-dest')];
        tripMap.setCenter(t.pickup);
      }
      // The planned road, once: pickup to destination through the stops.
      var line = Array.isArray(t.line) ? t.line.filter(validPoint) : [];
      if (!tripLine && line.length > 1) tripLine = routeLine(g, tripMap, line);

      if (!position) {
        if (!mapFitted) { frame(g, tripMap, line.length > 1 ? line : [t.pickup, t.destination], 50); mapFitted = 'route'; }
        return;
      }
      var look = 'pin-driver' + (t.positionFresh ? '' : ' stale');
      if (!carMarker) carMarker = new HtmlMarker(tripMap, position, look);
      else { carMarker.setLook(look); carMarker.glideTo(position); }

      if (mapFitted !== true) {
        // Open on the car AND where it is heading, so the first look answers "how far?".
        var goal = t.status === 'IN_PROGRESS' ? t.destination : t.pickup;
        frame(g, tripMap, [position, goal], 50);
        mapFitted = true;
      } else if (followCar) {
        tripMap.panTo(position);
      }
    });
  }

  W.$('d-call').addEventListener('click', function () { track('call_driver_tapped'); });
  W.$('d-chat').addEventListener('click', function () { track('chat_driver_tapped'); });
  W.$('back-to-chat').addEventListener('click', function () { track('chat_link_tapped', { from: 'offers' }); });
  W.$('idle-back').addEventListener('click', function () { track('chat_link_tapped', { from: 'ended' }); });
  W.$('map-recentre').addEventListener('click', function () {
    track('map_recentred');
    followCar = true;
    if (tripMap && carMarker) {
      tripMap.panTo(carMarker.pos);
      if (tripMap.getZoom() < 15) tripMap.setZoom(15);
    }
  });

  function drawConfirmed(s) {
    if (s.route) drawRoute(s.route);
    if (s.trip) drawTrip(s.trip);
    else W.show(W.$('map-card'), false);
    var driver = s.driver || {};
    // As the app's trip screen: "Tunde · 4.9", the car under it, the plate on the right.
    var name = (driver.name || 'Your driver').trim();
    // The app's headline: "Tunde is on the way", then "Heading to Ikeja City Mall".
    var first = driver.name ? name.split(/\s+/)[0] : 'Your driver';
    var status = s.trip && s.trip.status;
    var dest = shortPlace((s.route && s.route.destAddress) || (s.trip && s.trip.destination && s.trip.destination.address));
    W.$('trip-title').textContent = status === 'IN_PROGRESS' ? 'Heading to ' + (dest || 'your destination')
      : status === 'ARRIVED' ? first + ' has arrived'
      : first + ' is on the way';
    W.$('d-initial').textContent = initials(name);
    W.$('d-name').textContent = name + (driver.rating ? ' · ' + Number(driver.rating).toFixed(1) : '');
    W.$('d-fare').textContent = W.naira(driver.fareNgn || s.offerNgn);
    W.$('d-vehicle').textContent = driver.vehicle || '';
    W.$('d-plate').textContent = driver.plate || '';
    W.show(W.$('d-plate'), Boolean(driver.plate));
    W.show(W.$('d-foot'), Boolean(s.paidWithXlm));
    W.$('d-foot').textContent = s.paidWithXlm
      ? 'Paying ' + Number(s.paidWithXlm.amountXlm).toLocaleString('en-NG', { maximumFractionDigits: 2 }) + ' XLM from your Stellar wallet (testnet). It goes to your driver when the trip ends.'
      : '';
    var call = W.$('d-call');
    W.show(call, Boolean(driver.phone));
    if (driver.phone) call.setAttribute('href', 'tel:' + driver.phone);
    var chat = W.$('d-chat');
    W.show(chat, Boolean(s.tripChatUrl));
    if (s.tripChatUrl) chat.setAttribute('href', s.tripChatUrl);
    // Before the trip: the code to give the driver.
    W.show(W.$('d-code-box'), Boolean(s.tripCode));
    W.$('d-code').textContent = s.tripCode || '';
  }

  /* ── the loop ─────────────────────────────────────────────────────────── */

  /** The screen for the state, with what only this page knows on top. */
  function viewFor(s) {
    if (s.phase === 'idle') {
      if (local.plan) return 'plan';
      var last = lastSearchOf(s);
      if (last && noDriverClosed !== noDriverSig(last)) return 'nodriver';
      return 'idle';
    }
    if (s.phase === 'offers') return local.confirming ? 'confirming' : 'offers';
    if (s.phase === 'confirmed') return showFound(s) ? 'found' : 'confirmed';
    return s.phase === 'price' ? 'price' : 'idle';
  }

  function render() {
    if (!state || shownView === 'fatal') return;
    var view = viewFor(state);
    var changed = view !== shownView;
    if (changed) {
      shownView = view;
      W.showOnly(view);
      document.body.classList.toggle('on-home', view === 'idle');
    }
    if (view === 'idle') drawHome(state, changed);
    else if (view === 'plan') drawPlan();
    else if (view === 'nodriver') drawNoDriver(state, changed);
    else if (view === 'price') drawPrice(state);
    else if (view === 'offers') drawSent(state);
    else if (view === 'confirming') drawConfirming();
    else if (view === 'found') drawFound(state);
    else if (view === 'confirmed') drawConfirmed(state);
  }

  function apply(next) {
    if (!next || typeof next.phase !== 'string') return;
    var before = state && state.phase;
    state = next;
    // Each answer carries the map key (null: no maps on this server).
    mapsKey = typeof next.mapsKey === 'string' && next.mapsKey ? next.mapsKey : null;
    if (next.phase !== 'offers') { seenOffers = null; paying = null; declined = null; offerSnapshot = null; local.confirming = null; }
    // The trip moved on while Plan was open (a price, a search, a ride): its history entry goes too, so Back works.
    if (next.phase !== 'idle' && local.plan) {
      local.plan = false;
      clearTimeout(planTimer);
      if (history.state && history.state.view === 'plan') { try { history.back(); } catch (e) { /* ignore */ } }
    }

    if (before !== next.phase) {
      track('phase_shown', { from: before || 'none' });
      if (next.phase !== 'offers') closeSheets();
      if (before === 'confirmed' && next.phase === 'idle') local.endedNote = 'Trip ended';
      if (before === 'offers' && next.phase === 'idle' && !lastSearchOf(next) && !local.cancelledHere) say('Search ended');
      if (next.phase !== 'idle') local.endedNote = null;
      local.cancelledHere = false;
    }
    // Back from a search to change the trip: the box holds the price they had out (raised or not).
    if (before === 'offers' && next.phase === 'price' && next.lastOfferNgn) W.$('price-input').value = Number(next.lastOfferNgn).toLocaleString('en-NG');
    render();
  }

  function refresh() {
    return api('GET', '/ride-page/state').then(apply).catch(function (error) {
      if (error.status === 401) fatal(error.message);
      // Anything else — a dropped connection, a slow server — just waits for the next tick.
    });
  }

  function loop() {
    if (stopped) return;
    var wait = state && state.phase === 'confirmed' ? TRACK_MS : POLL_MS;
    polling = setTimeout(function () {
      // Confirming keeps asking: the poll may see the driver confirmed before the accept answers.
      if (document.hidden || (busy && !local.confirming)) return loop();
      refresh().then(loop);
    }, wait);
  }
  track('page_opened');
  refresh().then(loop);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      track('page_hidden', { secondsOnPage: secondsHere() });
      sendSteps(true);
      return;
    }
    track('page_visible', { secondsOnPage: secondsHere() });
    if (!stopped) refresh();
  });
  // Closing the tab, or WhatsApp closing its browser: the last steps go with keepalive.
  window.addEventListener('pagehide', function () {
    track('page_left', { secondsOnPage: secondsHere() });
    sendSteps(true);
  });
})();
