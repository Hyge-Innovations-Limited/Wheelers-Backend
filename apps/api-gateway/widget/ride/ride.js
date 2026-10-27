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
 * driversNotified, bidsCloseAt, lastSearch, scheduleUntil, rideCancelReasons,
 * supportContact, places on the trip) are all optional:
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
    cancelledHere: false,    // the search was cancelled on this page: no "Search ended" too
    rideCancelledHere: false // the ride was cancelled on this page: "Ride cancelled", not "Trip ended"
  };

  /* ── screens over Home: Plan your trip, Later, saved places ──────────────
   * Each has its own history entry ({ view, depth }), so the phone's Back
   * steps back through them instead of closing the page. */
  var nav = [];              // the screens open over Home, in order: 'plan', 'schedule', 'schedule-confirm', 'places', 'place-edit'
  function topScreen() { return nav.length ? nav[nav.length - 1] : null; }
  function navEntry() { return nav.length ? { view: topScreen(), depth: nav.length } : null; }
  function syncNav() {
    local.plan = topScreen() === 'plan';
    // Later is over once its screen is left: Plan your trip books for now again.
    if (nav.indexOf('schedule') < 0) { sched.at = null; sched.quote = null; }
  }
  function pushScreen(name) {
    nav.push(name);
    syncNav();
    try { history.pushState(navEntry(), ''); } catch (e) { /* ignore */ }
    render();
  }
  /** One screen back, as the phone's Back would. */
  function backScreen() {
    if (!nav.length) return;
    if (history.state && history.state.depth === nav.length) { try { history.back(); return; } catch (e) { /* below */ } }
    nav.pop();
    syncNav();
    render();
  }
  /** Straight back to Home (a trip planned, a ride booked for later): every screen's entry goes too. */
  function navHome() {
    var entries = history.state && typeof history.state.depth === 'number' ? history.state.depth : 0;
    // A sheet open over the screens has its own entry on top: it goes too.
    if (history.state && history.state.sheet) entries += 1;
    nav = [];
    syncNav();
    clearTimeout(planTimer);
    hideSheets();
    if (entries > 0) { try { history.go(-entries); } catch (e) { /* ignore */ } }
  }
  /** The history moved (Back, or a forward swipe): the screens follow it. */
  function onScreenEntry(entry) {
    var depth = entry && typeof entry.depth === 'number' ? entry.depth : 0;
    if (depth < nav.length) {
      nav = nav.slice(0, depth);
      syncNav();
      clearTimeout(planTimer);
      render();
    } else if (depth > nav.length) {
      // Forward onto a screen already left: stay on what is true now.
      if (shownView && shownView !== 'fatal' && shownView !== 'expired') W.showOnly(shownView);
      try { history.replaceState(navEntry(), ''); } catch (e) { /* ignore */ }
    }
  }

  // Its own name in the tab's storage: the Trip chat opened from here (same tab) keeps another link's token.
  // The start template's one-time code was spent or unknown (/ride-page/open answers #expired=1):
  // "This link has expired", and the way back. No link, so nothing is asked of the server; the
  // number is the one the server's own expired answer falls back to (EXPIRED_CHAT_URL).
  if (/(?:^#|&)expired=1(?:&|$)/.test(window.location.hash)) {
    try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
    W.showOnly('expired');
    var expiredBack = W.$('expired-back');
    expiredBack.setAttribute('href', 'https://wa.me/2348141979106');
    W.show(expiredBack, true);
    return;
  }

  if (!W.takeToken('wheelers.ride.page.token')) { W.fatal('This link is not valid.'); return; }

  /** The link itself is no good here (expired, or made for another page): nothing more to ask. */
  function linkDead(error) { return Boolean(error) && (error.status === 401 || error.status === 403); }

  function fatal(message) {
    stopped = true;
    clearTimeout(polling);
    shownView = 'fatal';
    document.body.classList.remove('on-home');
    W.fatal(message);
  }

  /** The server refused the link: its time is up (one line, back to WhatsApp), or it is no good here. */
  function dead(error) {
    if (error && error.code === 'LINK_EXPIRED') return expired(error.body && error.body.chatUrl);
    fatal(error.message);
  }
  function expired(chatUrl) {
    if (shownView === 'expired') return;
    stopped = true;
    clearTimeout(polling);
    hideSheets();
    shownView = 'expired';
    document.body.classList.remove('on-home');
    W.showOnly('expired');
    var back = W.$('expired-back');
    var url = typeof chatUrl === 'string' && /^https:\/\/wa\.me\//.test(chatUrl) ? chatUrl : '';
    W.show(back, Boolean(url));
    if (url) back.setAttribute('href', url);
    track('link_expired_shown');
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
  var ICON_TRASH = ['M5 7h14', 'M10 4h4', 'M7 7l1 12.5h8L17 7', 'M10.5 10.5v6M13.5 10.5v6'];

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
        row.setAttribute('data-edit', String(index));
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
  var mapsBroken = false;     // the key was refused: no maps on this visit
  var mapsFailedAt = 0;       // the script did not load: no maps for a while, then another try
  var MAPS_RETRY_MS = 30000;
  function mapsOff() { return mapsBroken || (mapsFailedAt > 0 && Date.now() - mapsFailedAt < MAPS_RETRY_MS); }
  function hideMaps() {
    ['home-map-wrap', 'find-map-wrap', 'map-card'].forEach(function (id) { W.show(W.$(id), false); });
    var offers = document.querySelector('section[data-view="offers"]');
    if (offers) offers.classList.remove('with-map');
  }
  var mapsLoading = null;
  var HtmlMarker = null;

  // Google calls this when the key is refused (wrong referrer, billing off):
  // every map goes away, and the rest of each screen works as without one.
  window.gm_authFailure = function () {
    mapsBroken = true;
    hideMaps();
  };

  function loadMaps() {
    if (!mapsKey || mapsOff()) return Promise.resolve(null);
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
      script.onerror = function () {
        // Blocked or offline: the boxes go, and the next draw after a while loads it again.
        mapsFailedAt = Date.now();
        mapsLoading = null;
        if (script.parentNode) script.parentNode.removeChild(script);
        hideMaps();
        resolve(null);
      };
      document.head.appendChild(script);
    });
    return mapsLoading;
  }

  /** Runs `draw` once the maps are in; never when there is no key or it was refused. */
  function withMaps(draw) {
    loadMaps().then(function (g) {
      if (!g || mapsOff()) return;
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

  var SHEETS = ['sheet-offer', 'sheet-pay', 'sheet-confirm', 'sheet-cancel', 'sheet-time', 'sheet-scheduled', 'sheet-sos', 'sheet-auto', 'sheet-route-price'];
  var sheetBackPending = false;   // closeSheets() went back one entry; that popstate is ours
  function openSheetId() {
    for (var i = 0; i < SHEETS.length; i++) if (!W.$(SHEETS[i]).hidden) return SHEETS[i];
    return null;
  }
  function onSheetEntry() { return Boolean(history.state && history.state.sheet); }

  function openSheet(id) {
    hideSheets();
    W.show(W.$('overlay'), true);
    W.show(W.$(id), true);
    // One history entry per open sheet (a sheet opened over another takes its place).
    try {
      if (onSheetEntry()) history.replaceState({ sheet: id, depth: nav.length }, '');
      else history.pushState({ sheet: id, depth: nav.length }, '');
    } catch (e) { /* ignore */ }
  }
  function closeSheets() {
    var hadSheet = Boolean(openSheetId());
    hideSheets();
    if (hadSheet && onSheetEntry()) {
      sheetBackPending = true;
      try { history.back(); } catch (e) { sheetBackPending = false; }
    }
  }
  function hideSheets() {
    SHEETS.forEach(function (id) { W.show(W.$(id), false); });
    W.show(W.$('overlay'), false);
    if (asking) { var answer = asking; asking = null; answer(false); }
    // Put away without an answer: no search starts.
    if (askingAuto) { var auto = askingAuto; askingAuto = null; auto(null); }
    if (askingRoute) { var routeAnswer = askingRoute; askingRoute = null; routeAnswer(null); }
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
  function keepLooking(key) {
    // The offer they backed out of: the server lets go of that choice only, not a newer one.
    api('POST', '/ride-page/keep-looking', key ? { key: key } : undefined).then(function (next) {
      if (next && typeof next.phase === 'string' && !busy) apply(next);
    }).catch(function () { /* an older server has no such step: nothing to forget there */ });
  }
  function addStepOpen() { return !W.$('sheet-pay').hidden && !W.$('pay-add').hidden; }

  function sheetPutAway() {
    var leftAdd = addStepOpen();
    noteSheetLeft();
    closeSheets();
    if (leftAdd) keepLooking(paying && paying.key);
    paying = null;
    payWith = null;
    if (state && state.phase === 'offers' && shownView === 'offers') drawSent(state);
  }
  W.$('overlay').addEventListener('click', sheetPutAway);
  window.addEventListener('popstate', function (event) {
    // The link's time is up (or it was refused): Back shows nothing under it (common.js's own
    // listener may have shown a screen's view from the history entry: put the note back).
    if (shownView === 'expired' || shownView === 'fatal') { W.showOnly(shownView); return; }
    if (sheetBackPending) {
      sheetBackPending = false;
      // A sheet opened while that step back was on its way: it gets its entry again.
      var open = openSheetId();
      if (open) { try { history.pushState({ sheet: open, depth: nav.length }, ''); } catch (e) { /* ignore */ } }
      return;
    }
    var toSheet = Boolean(event.state && event.state.sheet);
    // Back with a sheet open: the sheet goes, as its Back/Keep button would.
    if (openSheetId() && !toSheet) { sheetPutAway(); onScreenEntry(event.state); return; }
    // A forward swipe onto an old sheet entry: nothing to show.
    if (toSheet && !openSheetId()) { try { history.replaceState(navEntry(), ''); } catch (e) { /* ignore */ } return; }
    onScreenEntry(event.state);
  });
  // A reload keeps the tab's history state: an entry left from a sheet or a screen means nothing now.
  if (history.state && (history.state.sheet || history.state.view)) {
    try { history.replaceState(null, ''); } catch (e) { /* ignore */ }
  }
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
          if (linkDead(error)) dead(error);
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
    if (!mapsKey || mapsOff()) { W.show(W.$('home-map-wrap'), false); return; }
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
  function placeRow(place, iconPaths, ink, onPick, iconClass) {
    var row = el('button', 'result-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    var round = el('span', 'result-icon' + (ink ? ' ink' : '') + (iconClass ? ' ' + iconClass : ''));
    round.appendChild(icon(iconPaths));
    row.appendChild(round);
    var words = el('span', 'result-words');
    words.appendChild(el('strong', '', place.title || place.name || shortPlace(place.address)));
    var sub = place.subtitle !== undefined ? place.subtitle : (place.area || '');
    if (sub) words.appendChild(el('span', '', sub));
    row.appendChild(words);
    if (!ink && iconClass !== 'saved') row.appendChild(icon(ICON_CHEVRON, function (svg) { svg.setAttribute('class', 'result-chevron'); }));
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

    drawNotice(s);
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

    // Later (a ride for later), the next one booked, and the places saved on this phone.
    W.show(W.$('home-later'), Boolean(s.canSchedule));
    drawScheduledCard();
    drawSavedChips();

    if (changed) {
      if (loc.state === 'idle') askLocation();
      drawHomeMap();
      if (s.canSchedule) loadScheduled();
    }
    layoutSheet();
  }

  /**
   * A note from the server for Home (state.notice: { id, text }, e.g. a ride for later that could not
   * start): shown once. It is marked seen as soon as it shows, and stays until dismissed on this visit.
   */
  var notice = null;          // { id, text } on Home now
  var noticesSeen = {};       // ids told to the server
  function drawNotice(s) {
    var next = s && s.notice && typeof s.notice.id === 'string' && typeof s.notice.text === 'string' && s.notice.text ? s.notice : null;
    if (next && !noticesSeen[next.id] && (!notice || notice.id !== next.id)) notice = { id: next.id, text: next.text };
    W.show(W.$('home-notice'), Boolean(notice));
    W.$('home-notice-text').textContent = notice ? notice.text : '';
    if (notice) markNoticeSeen(notice.id);
  }
  function markNoticeSeen(id) {
    if (noticesSeen[id]) return;
    noticesSeen[id] = true;
    track('notice_shown', { id: id });
    api('POST', '/ride-page/notice/seen', { id: id }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      noticesSeen[id] = false;   // told again at the next draw
    });
  }
  W.$('home-notice-close').addEventListener('click', function () {
    if (!notice) return;
    markNoticeSeen(notice.id);
    track('notice_dismissed', { id: notice.id });
    notice = null;
    W.show(W.$('home-notice'), false);
    layoutSheet();
  });

  W.$('home-search').addEventListener('click', function () { openPlan({}); });
  W.$('home-later').addEventListener('click', function () { openSchedule(); });

  /** The app's chips: Home, Work and the rest, then the + tile; or "Add a place" when there are none. */
  var savedChipsSig = null;
  function drawSavedChips() {
    var saved = readSaved();
    W.show(W.$('home-saved'), saved.length > 0);
    W.show(W.$('home-add-place'), saved.length === 0);
    var sig = JSON.stringify(saved);
    if (sig === savedChipsSig) return;
    savedChipsSig = sig;
    var holder = W.$('home-chips');
    holder.innerHTML = '';
    saved.forEach(function (place) {
      var chip = el('button', 'chip' + (saved.length <= 2 ? ' wide' : ''));
      chip.type = 'button';
      chip.setAttribute('aria-label', 'Go to ' + place.label);
      chip.appendChild(icon(savedIcon(place.label, ICON_PIN)));
      chip.appendChild(el('span', 'chip-text', place.label));
      chip.addEventListener('click', function () {
        track('place_picked', { field: 'destination', from: 'home_saved' });
        openPlan({ destination: { lat: place.lat, lng: place.lng, address: place.address, name: place.label } });
      });
      holder.appendChild(chip);
    });
  }
  W.$('home-places').addEventListener('click', function () { pushScreen('places'); });
  W.$('home-add-place').addEventListener('click', function () { pushScreen('places'); });

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

  // pickup / destination / each stop: { lat, lng, address, name?, area? }, null while being typed.
  // A field is named 'pickup', 'destination', or a stop's place in line ('0', '1', '2').
  // mode: 'book' (a trip to price) or 'route' (the trip under way: "Change your route", as the app's
  // trip-edit); over: the phase it was opened over ('idle', 'price' from Set your price, 'confirmed' from the trip).
  var plan = { pickup: null, destination: null, stops: [], active: 'destination', query: '', results: [], searching: false, searchedFor: null, error: null, seq: 0, autoPickup: false, session: null, picking: false, mode: 'book', over: 'idle' };
  var planTimer = null;
  var MAX_STOPS_DEFAULT = 3;   // the chat's limit; the server says its own (maxStops)

  function maxStops() { return state && Number(state.maxStops) >= 0 ? Number(state.maxStops) : MAX_STOPS_DEFAULT; }
  function isStop(field) { return field !== 'pickup' && field !== 'destination'; }
  function fieldPlace(field) { return field === 'pickup' ? plan.pickup : field === 'destination' ? plan.destination : plan.stops[Number(field)] || null; }
  function setFieldPlace(field, place) {
    if (field === 'pickup') plan.pickup = place;
    else if (field === 'destination') plan.destination = place;
    else plan.stops[Number(field)] = place;
  }
  function planFields() {
    return ['pickup'].concat(plan.stops.map(function (_, index) { return String(index); }), ['destination']);
  }
  function inputFor(field) {
    if (field === 'pickup') return W.$('plan-from');
    if (field === 'destination') return W.$('plan-to');
    return document.querySelector('[data-plan-input="' + field + '"]') || W.$('plan-to');
  }

  /** Google bills a search and its pick as one session: a new one for each place. */
  function newSession() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* below */ }
    return 's' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  }

  function placeOf(p) { return { lat: p.lat, lng: p.lng, address: p.address, name: p.name, area: p.area }; }
  /**
   * options: destination (a place picked on Home), or trip ({ pickup, destination, stops }: the trip
   * as it is, from Set your price or the trip), field (the one to open on, selected), mode, over.
   */
  function openPlan(options) {
    options = options || {};
    var trip = options.trip || null;
    // The trip under way's pickup is not the next booking's: Home starts from the phone again.
    if (!trip && plan.mode === 'route') { plan.pickup = null; plan.autoPickup = false; }
    plan.mode = options.mode === 'route' ? 'route' : 'book';
    plan.over = options.over || 'idle';
    if (trip) {
      plan.pickup = placeOf(trip.pickup);
      plan.autoPickup = false;
      plan.destination = placeOf(trip.destination);
      plan.stops = (trip.stops || []).filter(function (stop) { return validPoint(stop) && stop.address; }).map(placeOf).slice(0, maxStops());
    } else {
      plan.destination = options.destination || null;
      plan.stops = [];
      if (!plan.pickup && loc.place) { plan.pickup = loc.place; plan.autoPickup = true; }
    }
    plan.query = '';
    plan.results = [];
    plan.error = null;
    plan.searching = false;
    plan.seq++;
    plan.session = newSession();
    W.show(W.$('plan-err'), false);
    // A stop asked for that is not on the trip (no place for it): the destination.
    if (options.field && isStop(options.field) && !(Number(options.field) < plan.stops.length)) options.field = 'destination';
    plan.active = options.field || (!plan.pickup ? 'pickup' : 'destination');
    W.$('plan-from').value = plan.pickup ? plan.pickup.address : '';
    W.$('plan-to').value = plan.destination ? plan.destination.address : '';
    // Changing the route of a trip under way: the pickup stays (the driver is coming there).
    W.$('plan-from').disabled = plan.mode === 'route';
    W.$('plan-title').textContent = plan.mode === 'route' ? 'Change your route' : 'Plan your trip';
    W.$('plan-go').textContent = plan.mode === 'route' ? 'Update trip route' : 'Continue';
    planListSig = null;
    drawPlanStops(true);
    track('trip_edit_opened', { from: trip ? plan.over : sched.at ? 'schedule' : 'home', field: options.field || undefined });
    pushScreen('plan');
    // The cursor in the field asked for, selected to type over; or in the one that needs filling
    // (in the same tap, so the keyboard opens). The trip as it is opens showing the whole of it.
    if (options.field) focusField(options.field);
    else if (!trip && !(plan.pickup && plan.destination)) inputFor(plan.active).focus();
  }

  // The phone's own back (Android's button, the iOS swipe) closes Plan your trip, not the page (onScreenEntry).
  function leavePlan() {
    if (!local.plan) return;
    clearTimeout(planTimer);
    backScreen();
  }
  W.$('plan-back').addEventListener('click', leavePlan);

  /** The stop rows between From and To, as the app's (a ring, STOP 1, the bin to take it off). */
  var planStopsDrawn = -1;
  function drawPlanStops(force) {
    if (!force && planStopsDrawn === plan.stops.length) return;
    planStopsDrawn = plan.stops.length;
    var holder = W.$('plan-stops');
    holder.innerHTML = '';
    plan.stops.forEach(function (stop, index) {
      var field = String(index);
      var row = el('div', 'plan-field');
      row.setAttribute('data-plan', field);
      row.appendChild(el('span', 'plan-mark hollow'));
      var label = el('span', 'plan-label', 'STOP ' + (index + 1));
      label.setAttribute('aria-hidden', 'true');
      row.appendChild(label);
      var input = el('input');
      input.setAttribute('data-plan-input', field);
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', 'words');
      input.setAttribute('enterkeyhint', 'search');
      input.setAttribute('placeholder', 'Search stop');
      input.setAttribute('aria-label', 'Stop ' + (index + 1));
      input.value = plan.active === field && plan.query ? plan.query : stop ? stop.address : '';
      wirePlanInput(input);
      row.appendChild(input);
      var remove = el('button', 'plan-clear plan-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove stop ' + (index + 1));
      remove.appendChild(icon(ICON_TRASH));
      remove.addEventListener('click', function () { removeStop(index); });
      row.appendChild(remove);
      holder.appendChild(row);
      var line = el('div', 'plan-line');
      line.setAttribute('data-plan-line', field);
      holder.appendChild(line);
    });
  }

  function addStop() {
    if (plan.stops.length >= maxStops() || plan.stops.some(function (stop) { return !stop; })) return;
    plan.stops.push(null);
    drawPlanStops(true);
    track('stop_added', { stops: plan.stops.length });
    focusField(String(plan.stops.length - 1));
  }
  function removeStop(index) {
    var active = plan.active;
    plan.stops.splice(index, 1);
    track('stop_removed', { stops: plan.stops.length });
    // The field being typed in keeps the cursor; one below the removed stop moves up.
    if (isStop(active)) {
      var at = Number(active);
      if (at === index) { plan.active = 'destination'; plan.query = ''; plan.results = []; }
      else if (at > index) plan.active = String(at - 1);
    }
    drawPlanStops(true);
    drawPlan();
  }
  W.$('plan-add-stop').addEventListener('click', addStop);

  /* saved places: on this phone, as the app's (lib/saved-places.ts) */

  var SAVED_KEY = 'wheelers.ride.savedPlaces';
  var MAX_SAVED = 8;
  function savedRank(place) { var label = norm(place.label); return label === 'home' ? 0 : label === 'work' ? 1 : 2; }
  function readSaved() {
    var list = readStore('localStorage', SAVED_KEY);
    if (!Array.isArray(list)) return [];
    return list.filter(function (p) {
      return p && typeof p.id === 'string' && typeof p.label === 'string' && p.label.trim() && typeof p.address === 'string' && p.address.trim() && validPoint(p);
    }).slice(0, MAX_SAVED).map(function (p, index) { return { place: p, index: index }; })
      // Home first, then Work, then the rest in the order they were saved.
      .sort(function (a, b) { return savedRank(a.place) - savedRank(b.place) || a.index - b.index; })
      .map(function (item) { return item.place; });
  }
  /** False when the phone would not keep it (private mode, storage full or blocked). */
  function writeSaved(list) {
    try {
      var text = JSON.stringify(list.slice(0, MAX_SAVED));
      window.localStorage.setItem(SAVED_KEY, text);
      return window.localStorage.getItem(SAVED_KEY) === text;
    } catch (e) { return false; }
  }
  var ICON_HOME = ['M4 10.5L12 4l8 6.5', 'M6 9v10.5h4.5V15h3v4.5H18V9'];
  var ICON_WORK = ['M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7', 'M4 12.5h16'];
  var ICON_BOOKMARK = ['M7 4h10v16l-5-3.5L7 20z'];
  /** Home, Work, or the pin (on Home's chips) / the bookmark (in Plan your trip's list), as the app's. */
  function savedIcon(label, other) {
    var name = norm(label);
    return name === 'home' ? ICON_HOME : name === 'work' ? ICON_WORK : other;
  }

  var planListSig = null;
  function drawPlan() {
    var typing = plan.query.trim().length > 0;
    drawPlanStops(false);
    planFields().forEach(function (field) {
      var input = inputFor(field);
      var clear = document.querySelector('[data-plan-clear="' + field + '"]');
      if (clear) W.show(clear, input.value.length > 0 && !input.disabled);
      var line = document.querySelector('[data-plan-line="' + field + '"]');
      if (line) line.classList.toggle('active', plan.active === field);
    });
    // As the app: + Add stop until the stops are full; one at a time (the last must be filled first).
    var full = plan.stops.length >= maxStops();
    var addStopButton = W.$('plan-add-stop');
    W.show(addStopButton, maxStops() > 0);
    addStopButton.disabled = !full && plan.stops.some(function (stop) { return !stop; });
    addStopButton.classList.toggle('full', full);
    addStopButton.lastChild.textContent = full ? 'Maximum stops reached' : 'Add stop';
    addStopButton.setAttribute('aria-label', full ? 'Maximum stops reached' : 'Add stop');
    if (full) addStopButton.disabled = true;

    var fromActive = plan.active === 'pickup';
    var recents = readRecents();
    var saved = typing ? [] : readSaved();
    var query = norm(plan.query);
    var listedRecents = (typing
      ? recents.filter(function (p) { return norm(p.address).indexOf(query) >= 0 || norm(p.name).indexOf(query) >= 0; })
      : recents).slice(0, 5);
    var results = typing ? plan.results.filter(function (r) {
      return !listedRecents.some(function (p) { return norm(p.address) === norm(r.address); });
    }) : [];

    W.$('plan-heading').textContent = typing ? 'Matching places' : fromActive ? 'Pickup' : (saved.length || listedRecents.length) ? 'Your places' : '';
    W.show(W.$('plan-spin'), plan.searching || plan.picking);

    var showError = Boolean(plan.error) && !plan.searching;
    var showNothing = typing && plan.query.trim().length >= 2 && !plan.searching && !plan.error && plan.searchedFor === plan.query.trim() && !listedRecents.length && !results.length;
    var hereRow = fromActive && !typing;
    var sig = JSON.stringify([hereRow, hereRow && loc.place ? loc.place.address : '', showError ? plan.error : '', saved, listedRecents, results, showNothing]);
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
    // Saved places first, before anything is typed (as the app's "YOUR PLACES").
    saved.forEach(function (place) {
      var row = placeRow({ title: place.label, subtitle: place.address }, savedIcon(place.label, ICON_BOOKMARK), false, function () {
        track('place_picked', { field: isStop(plan.active) ? 'stop' : plan.active, from: 'saved' });
        pickPlace(place, true);
      }, 'saved');
      holder.appendChild(row);
    });
    listedRecents.forEach(function (place) {
      holder.appendChild(placeRow(place, ICON_CLOCK, false, function () { pickPlace(place); }));
    });
    results.forEach(function (place) {
      holder.appendChild(placeRow(place, ICON_PIN, false, function () { pickSuggestion(place); }));
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
    var input = inputFor(field);
    input.focus();
    try { input.select(); } catch (e) { /* ignore */ }
  }

  /** The first field still empty, in the trip's order; null when every one is filled. */
  function emptyField() {
    var fields = planFields();
    for (var i = 0; i < fields.length; i++) if (!fieldPlace(fields[i])) return fields[i];
    return null;
  }

  function pickPlace(place, notRecent) {
    clearTimeout(planTimer);   // a search about to start is for the words this place replaces
    var field = plan.active;
    var picked = { lat: place.lat, lng: place.lng, address: place.address, name: place.name || place.label, area: place.area };
    setFieldPlace(field, picked);
    if (field === 'pickup') plan.autoPickup = false;
    inputFor(field).value = place.address;
    plan.searching = false;
    plan.seq++;   // a search still on its way is for the words just replaced
    plan.query = '';
    plan.results = [];
    plan.error = null;
    W.show(W.$('plan-err'), false);
    if (!notRecent) saveRecent(picked);
    if (!notRecent || !place.label) track('place_picked', { field: isStop(field) ? 'stop' : field });
    // As the app: on to what is missing; the destination picked last goes straight to the price
    // (changing the route of a trip under way waits for "Update trip route").
    var missing = emptyField();
    if (missing) return focusField(missing);
    if (field === 'destination' && plan.mode === 'book') return submitPlan();
    drawPlan();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  /** A Google suggestion tapped: where it is (by its id, in the same session), then it is the place. */
  function pickSuggestion(suggestion) {
    if (plan.picking || !suggestion || !suggestion.placeId) return;
    clearTimeout(planTimer);
    var field = plan.active;
    var seq = ++plan.seq;
    plan.picking = true;
    drawPlan();
    api('GET', '/ride-page/place?id=' + encodeURIComponent(suggestion.placeId) + '&session=' + encodeURIComponent(plan.session || '')).then(function (answer) {
      plan.picking = false;
      if (seq !== plan.seq || plan.active !== field || !local.plan) return;
      var spot = answer && answer.place;
      if (!validPoint(spot)) throw { message: 'Could not look that up. Try again.' };
      plan.session = newSession();
      pickPlace({ lat: spot.lat, lng: spot.lng, address: suggestion.address, name: suggestion.name, area: suggestion.area });
    }).catch(function (error) {
      plan.picking = false;
      if (linkDead(error)) return dead(error);
      if (seq !== plan.seq) return;
      plan.error = error.message || 'Could not look that up. Try again.';
      planListSig = null;
      if (shownView === 'plan') drawPlan();
    });
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
    // A search or a pick still on its way was for the field just left.
    clearTimeout(planTimer);
    plan.seq++;
    plan.searching = false;
    plan.active = field;
    plan.query = '';
    plan.results = [];
    plan.error = null;
    drawPlan();
  }
  function onPlanTyping() {
    var field = this.getAttribute('data-plan-input');
    // What is on its way (a search, a pick) was for the words just typed over.
    plan.seq++;
    plan.searching = false;
    plan.active = field;
    setFieldPlace(field, null);               // typed over: not a place until one is picked
    if (field === 'pickup') plan.autoPickup = false;
    plan.query = this.value;
    plan.error = null;
    W.show(W.$('plan-err'), false);
    clearTimeout(planTimer);
    var query = this.value.trim();
    if (query.length < 2) { plan.searching = false; plan.results = []; plan.seq++; drawPlan(); return; }
    drawPlan();
    planTimer = setTimeout(function () { searchPlaces(field, query); }, 280);
  }
  function onPlanKey(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    var typing = plan.query.trim();
    if (typing && plan.results.length) return pickSuggestion(plan.results[0]);
    if (!typing) submitPlan();
  }
  function wirePlanInput(input) {
    input.addEventListener('focus', onPlanFocus);
    input.addEventListener('input', onPlanTyping);
    input.addEventListener('keydown', onPlanKey);
  }
  ['plan-from', 'plan-to'].forEach(function (id) { wirePlanInput(W.$(id)); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-plan-clear]'), function (button) {
    button.addEventListener('click', function () {
      var field = button.getAttribute('data-plan-clear');
      setFieldPlace(field, null);
      if (field === 'pickup') plan.autoPickup = false;
      inputFor(field).value = '';
      focusField(field);
    });
  });

  function searchPlaces(field, query) {
    var seq = ++plan.seq;
    plan.searching = true;
    drawPlan();
    if (!plan.session) plan.session = newSession();
    api('GET', '/ride-page/suggest?q=' + encodeURIComponent(query) + '&session=' + encodeURIComponent(plan.session)).then(function (answer) {
      if (seq !== plan.seq) return;   // a newer search is on its way
      plan.results = ((answer && answer.places) || []).filter(function (p) { return p && p.placeId && p.address; });
      plan.error = null;
      track('place_searched', { field: isStop(field) ? 'stop' : field, letters: query.length, results: plan.results.length });
    }).catch(function (error) {
      if (seq !== plan.seq) return;
      if (linkDead(error)) return dead(error);
      plan.results = [];
      plan.error = error.message || 'Could not look that up. Try again.';
    }).then(function () {
      if (seq !== plan.seq) return;
      plan.searching = false;
      plan.searchedFor = query;
      if (shownView === 'plan') drawPlan();
    });
  }

  /** A field with words typed in it but no place picked from the list: the first, or null. */
  function unpickedField() {
    var fields = planFields();
    for (var i = 0; i < fields.length; i++) {
      var input = inputFor(fields[i]);
      if (!fieldPlace(fields[i]) && input && !input.disabled && input.value.trim()) return fields[i];
    }
    return null;
  }

  function submitPlan() {
    if (busy) return;
    // Typed but not picked (a stop too): never sent as if it were empty. The cursor goes there, the words stay.
    var unpicked = unpickedField();
    if (unpicked) {
      if (plan.active !== unpicked) { plan.active = unpicked; plan.query = inputFor(unpicked).value; plan.results = []; drawPlan(); }
      inputFor(unpicked).focus();
      return;
    }
    if (!plan.pickup) return focusField('pickup');
    if (!plan.destination) return focusField('destination');
    var button = W.$('plan-go');
    var pickup = { lat: plan.pickup.lat, lng: plan.pickup.lng, address: plan.pickup.address };
    var destination = { lat: plan.destination.lat, lng: plan.destination.lng, address: plan.destination.address };
    // A stop left empty is not one.
    var stops = plan.stops.filter(Boolean).map(function (stop) { return { lat: stop.lat, lng: stop.lng, address: stop.address }; });
    busy = true;
    button.className = 'btn primary busy';
    W.show(W.$('plan-err'), false);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // Later: the trip is priced for the pickup time chosen, and nothing is booked yet.
    if (sched.at) return quoteSchedule(pickup, destination, stops, button);
    // The trip under way: the new destination and stops go to the driver (the app's ride:route:update).
    if (plan.mode === 'route') return changeRoute(destination, stops, button);
    api('POST', '/ride-page/route', { pickup: pickup, destination: destination, stops: stops }).then(function (next) {
      track('trip_saved', { from: plan.over === 'price' ? 'price' : 'plan', distanceKm: next.route ? next.route.distanceKm : 0, suggestedNgn: next.route ? next.route.suggestedFareNgn : 0, stops: stops.length });
      if (next.route) rememberPlaces(next.route, { pickup: pickup, destination: destination, stops: stops });
      // Set your price's Back now comes back here (the trip was planned on this page).
      setPlanned(true);
      navHome();
      apply(next);
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('trip_save_failed', { code: error.code || String(error.status) });
      W.$('plan-err').textContent = error.message;
      W.show(W.$('plan-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  }

  W.$('plan-go').addEventListener('click', submitPlan);

  /**
   * The trip under way gets a new route. As the app, the price is asked about before any money moves:
   * the new fare is quoted first; when it differs, "₦X more will be held" (or less) waits for "Update route".
   * The fare agreed is sent with the change (the server refuses it as PRICE_CHANGED if it moved: quoted again).
   */
  function changeRoute(destination, stops, button, attempt) {
    attempt = attempt || 0;
    function done() { busy = false; button.className = 'btn primary'; }
    api('POST', '/ride-page/trip-route/quote', { destination: destination, stops: stops }).catch(function (error) {
      if (error.status === 404 && error.code !== 'NO_TRIP') return null;   // a server without the quote step
      throw error;
    }).then(function (quote) {
      var fare = quote && Number(quote.fareNgn) > 0 ? Math.round(Number(quote.fareNgn)) : null;
      var extra = quote ? Math.round(Number(quote.extraNgn) || 0) : 0;
      if (!quote || extra === 0) return sendRoute(destination, stops, fare, button, attempt);
      done();
      return askRoutePrice(fare, extra).then(function (yes) {
        if (yes === null) return;   // put away: Change your route stays as it is
        track('route_price_answered', { yes: yes, extraNgn: extra });
        if (!yes) return;   // "Keep my trip": already back on the trip
        if (busy) return;
        busy = true;
        button.className = 'btn primary busy';
        return sendRoute(destination, stops, fare, button, attempt);
      });
    }).catch(function (error) {
      routeFailed(error);
      done();
    });
  }
  function sendRoute(destination, stops, fare, button, attempt) {
    var body = { destination: destination, stops: stops };
    if (fare !== null) body.acceptedFareNgn = fare;
    return api('POST', '/ride-page/trip-route', body).then(function (next) {
      track('route_changed', { stops: stops.length, fareNgn: fare });
      busy = false;
      button.className = 'btn primary';
      navHome();
      apply(next);
    }, function (error) {
      // The fare moved between the quote and the change: quoted again, asked again (once).
      if (error.code === 'PRICE_CHANGED' && attempt < 1) return changeRoute(destination, stops, button, attempt + 1);
      throw error;
    });
  }
  function routeFailed(error) {
    if (linkDead(error)) return dead(error);
    track('route_change_failed', { code: error.code || String(error.status) });
    W.$('plan-err').textContent = error.message;
    W.show(W.$('plan-err'), true);
    // The trip moved on (it ended, or was cancelled): the next look shows where it is.
    if (error.status === 409 || error.status === 404) refresh();
  }

  /** "₦X more will be held" / "₦X less will be held", the new fare under it: true, false, or null when put away. */
  var askingRoute = null;
  function askRoutePrice(fare, extra) {
    return new Promise(function (resolve) {
      openSheet('sheet-route-price');
      W.$('rp-title').textContent = W.naira(Math.abs(extra)) + (extra > 0 ? ' more' : ' less') + ' will be held';
      W.$('rp-text').textContent = fare ? 'New fare ' + W.naira(fare) + '.' : '';
      W.show(W.$('rp-text'), Boolean(fare));
      askingRoute = resolve;
    });
  }
  function answerRoute(yes) {
    var answer = askingRoute;
    askingRoute = null;
    // "Keep my trip": back to the trip, the sheet's and the screen's history entries together.
    if (yes) closeSheets();
    else { navHome(); render(); }
    if (answer) answer(yes);
  }
  W.$('rp-yes').addEventListener('click', function () { answerRoute(true); });
  W.$('rp-no').addEventListener('click', function () { answerRoute(false); });

  /** The trip was planned on this page: Set your price's Back goes to Plan your trip, not WhatsApp. */
  var PLANNED_KEY = 'wheelers.ride.planned';
  var planned = readStore('sessionStorage', PLANNED_KEY) === true;
  function setPlanned(on) {
    if (planned === on) return;
    planned = on;
    writeStore('sessionStorage', PLANNED_KEY, on);
  }

  /* ── Later: a ride for later, as the app's (app/schedule-ride.tsx, lib/trip-words.ts) ── */

  var MIN_LEAD_MINUTES = 15;          // a pickup at least this far away
  var SCHEDULE_DAYS = 7;              // today and the next six days
  var SLOT_COUNT = 8;                 // half hours offered before "Choose another time"
  var FIRST_SLOT_LATER_DAY = 6 * 60;  // a later day starts at 6:00 am
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var ICON_CALENDAR = ['M7 3v3M17 3v3', 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5z', 'M4 10h16'];

  // at: the pickup chosen (a Date) once Continue is tapped; quote: the trip priced for it.
  // requestId: one booking however often Schedule ride is tapped; a new one for each trip or time quoted.
  var sched = { day: null, minutes: null, at: null, quote: null, requestId: null, quotedSig: null };
  function newRequestId() { return 'r' + newSession().replace(/[^A-Za-z0-9]/g, '').slice(0, 30); }
  var tp = { hour12: 12, minute: 0, pm: false, soon: false, late: false };

  function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
  function dayOffset(date, now) { return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86400000); }
  function minutesWords(minutesOfDay) {
    var hour24 = Math.floor(minutesOfDay / 60) % 24;
    var minute = minutesOfDay % 60;
    var hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return hour12 + ':' + pad2(minute) + ' ' + (hour24 < 12 ? 'am' : 'pm');
  }
  function timeWords(date) { return minutesWords(date.getHours() * 60 + date.getMinutes()); }
  /** "Today", "Tomorrow", or "Tuesday 13 Oct". */
  function dayWords(date, now) {
    var offset = dayOffset(date, now);
    if (offset === 0) return 'Today';
    if (offset === 1) return 'Tomorrow';
    return WEEKDAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()];
  }
  function pickupWords(date, now) { return dayWords(date, now) + ', ' + timeWords(date); }
  function pickupAt(dayStart, minutesOfDay) {
    return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  }
  /**
   * The latest pickup the server takes (state.scheduleUntil: the end of the rider's WhatsApp
   * window, when the start message could not reach them later), in ms; null: the 7 days.
   */
  function scheduleLimit() {
    var until = state && typeof state.scheduleUntil === 'string' ? Date.parse(state.scheduleUntil) : NaN;
    return isFinite(until) ? until : null;
  }
  function tooLate(pickup) { var limit = scheduleLimit(); return limit !== null && pickup.getTime() > limit; }
  function isPickupAllowed(pickup, now) { return pickup.getTime() - now.getTime() >= MIN_LEAD_MINUTES * 60000 && !tooLate(pickup); }
  /** Some minute of the day is at least 15 minutes away and not after the limit. */
  function dayHasTime(dayStart, now) {
    var earliest = Math.max(dayStart.getTime(), now.getTime() + MIN_LEAD_MINUTES * 60000);
    var latest = pickupAt(dayStart, 23 * 60 + 59).getTime();
    var limit = scheduleLimit();
    if (limit !== null) latest = Math.min(latest, limit);
    return earliest <= latest;
  }
  function scheduleDays(now) {
    var days = [];
    var limit = scheduleLimit();
    for (var index = 0; index < SCHEDULE_DAYS; index++) {
      var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index);
      // Only the days up to the limit are offered.
      if (index > 0 && limit !== null && start.getTime() > limit) break;
      days.push({ index: index, top: index === 0 ? 'Today' : WEEKDAYS[start.getDay()].slice(0, 3), num: start.getDate(), start: start });
    }
    return days;
  }
  /** Today: from the next half hour at least 15 minutes away; a later day: from 6:00 am. */
  function halfHourSlots(dayStart, now) {
    var first = FIRST_SLOT_LATER_DAY;
    if (dayOffset(dayStart, now) === 0) {
      var earliest = now.getHours() * 60 + now.getMinutes() + MIN_LEAD_MINUTES + (now.getSeconds() > 0 || now.getMilliseconds() > 0 ? 1 : 0);
      first = Math.ceil(earliest / 30) * 30;
    }
    var slots = [];
    for (var minutes = first; minutes < 24 * 60 && slots.length < SLOT_COUNT; minutes += 30) {
      if (isPickupAllowed(pickupAt(dayStart, minutes), now)) slots.push(minutes);
    }
    return slots;
  }

  /** What the screen shows now: the day (the first with time left when the one picked has none), the time, the pickup. */
  function scheduleChoice(now) {
    var days = scheduleDays(now);
    var day = (sched.day !== null && days[sched.day] && dayHasTime(days[sched.day].start, now) ? days[sched.day] : null)
      || days.filter(function (d) { return dayHasTime(d.start, now); })[0] || days[1] || days[0];
    var slots = halfHourSlots(day.start, now);
    var minutes = sched.minutes !== null && isPickupAllowed(pickupAt(day.start, sched.minutes), now) ? sched.minutes : (slots.length ? slots[0] : null);
    var choices = minutes === null || slots.indexOf(minutes) >= 0 ? slots : slots.concat([minutes]).sort(function (a, b) { return a - b; });
    return { days: days, day: day, minutes: minutes, choices: choices, pickup: minutes === null ? null : pickupAt(day.start, minutes) };
  }

  function openSchedule() {
    sched.day = null;
    sched.minutes = null;
    sched.at = null;
    sched.quote = null;
    W.show(W.$('sch-err'), false);
    track('schedule_opened');
    pushScreen('schedule');
  }
  W.$('sch-back').addEventListener('click', backScreen);

  function drawSchedule() {
    var now = new Date();
    var c = scheduleChoice(now);
    var days = W.$('sch-days');
    days.innerHTML = '';
    c.days.forEach(function (d) {
      var on = d.index === c.day.index;
      var open = dayHasTime(d.start, now);
      var chip = el('button', 'day' + (on ? ' on' : ''));
      chip.type = 'button';
      chip.disabled = !open;
      chip.setAttribute('aria-label', dayWords(d.start, now));
      chip.setAttribute('aria-pressed', String(on));
      chip.appendChild(el('span', 'day-top', d.top));
      chip.appendChild(el('span', 'day-num', String(d.num)));
      chip.addEventListener('click', function () { sched.day = d.index; W.show(W.$('sch-err'), false); drawSchedule(); });
      days.appendChild(chip);
    });
    var times = W.$('sch-times');
    times.innerHTML = '';
    c.choices.forEach(function (value) {
      var on = value === c.minutes;
      var chip = el('button', 'time' + (on ? ' on' : ''), minutesWords(value));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(on));
      chip.addEventListener('click', function () { sched.minutes = value; sched.day = c.day.index; W.show(W.$('sch-err'), false); drawSchedule(); });
      times.appendChild(chip);
    });
    // As the app: no half hour left on the day; nothing at all when no day has a time.
    var anyDay = c.days.some(function (d) { return dayHasTime(d.start, now); });
    var otherDay = c.days.some(function (d) { return d.index !== c.day.index && dayHasTime(d.start, now); });
    W.show(W.$('sch-none'), c.choices.length === 0);
    W.$('sch-none').textContent = !anyDay ? (windowClosed(now, scheduleLimit()) ? WINDOW_CLOSED : 'No pickup times left.')
      : 'No half-hour times are left' + (dayOffset(c.day.start, now) === 0 ? ' today' : '') + '. Choose another time' + (otherDay ? ' or another day' : '') + '.';
    W.show(W.$('sch-another'), anyDay);
    W.$('sch-when').textContent = c.pickup ? dayWords(c.pickup, now) + ', ' + minutesWords(c.minutes) : 'Choose a time';
    W.$('sch-go').disabled = !c.pickup;
  }
  // The clock moves on: a time 16 minutes away is not offered once it is 14.
  setInterval(function () { if (shownView === 'schedule') drawSchedule(); }, 30000);

  W.$('sch-go').addEventListener('click', function () {
    var now = new Date();
    var c = scheduleChoice(now);
    if (!c.pickup || !isPickupAllowed(c.pickup, now)) {
      W.$('sch-err').textContent = !c.pickup ? 'Choose a pickup time.'
        : tooLate(c.pickup) ? lateWords(now)
        : 'That time is too close. Choose a time at least ' + MIN_LEAD_MINUTES + ' minutes from now.';
      W.show(W.$('sch-err'), true);
      return drawSchedule();
    }
    sched.at = c.pickup;
    sched.requestId = newRequestId();
    sched.quotedSig = null;
    openPlan({});
  });

  /* choose another time: hour, minute (five at a time), am or pm */

  W.$('sch-another').addEventListener('click', function () {
    var c = scheduleChoice(new Date());
    var from = c.minutes;
    if (from === null) {
      from = 0;
      for (var value = 0; value < 24 * 60; value += 5) { if (isPickupAllowed(pickupAt(c.day.start, value), new Date())) { from = value; break; } }
    }
    from -= from % 5;
    var hour = Math.floor(from / 60) % 12;
    tp.hour12 = hour === 0 ? 12 : hour;
    tp.minute = from % 60;
    tp.pm = from >= 12 * 60;
    tp.soon = false;
    tp.late = false;
    tp.day = c.day;
    W.$('tp-day').textContent = dayWords(c.day.start, new Date());
    drawTimePicker();
    openSheet('sheet-time');
  });
  function tpValue() { return ((tp.hour12 % 12) + (tp.pm ? 12 : 0)) * 60 + tp.minute; }
  /** "Choose a time by 3:30 pm." (or "by tomorrow, 9:00 am."): the latest the server takes. */
  var WINDOW_CLOSED = 'Send any message in WhatsApp, then pick a time.';
  /** The latest time is now or less than 15 minutes away: a message in WhatsApp opens the window again. */
  function windowClosed(now, limit) { return limit !== null && isFinite(limit) && limit < now.getTime() + MIN_LEAD_MINUTES * 60000; }
  function lateWords(now, limit) {
    if (limit === undefined) limit = scheduleLimit();
    if (limit === null || !isFinite(limit)) return 'Choose an earlier time.';
    if (windowClosed(now, limit)) return WINDOW_CLOSED;
    var by = new Date(limit);
    return 'Choose a time by ' + (dayOffset(by, now) === 0 ? timeWords(by) : homeWhen(by, now)) + '.';
  }
  function drawTimePicker() {
    W.$('tp-hour').textContent = String(tp.hour12);
    W.$('tp-min').textContent = pad2(tp.minute);
    W.$('tp-am').className = 'half' + (tp.pm ? '' : ' on');
    W.$('tp-pm').className = 'half' + (tp.pm ? ' on' : '');
    W.$('tp-am').setAttribute('aria-pressed', String(!tp.pm));
    W.$('tp-pm').setAttribute('aria-pressed', String(tp.pm));
    W.$('tp-set').textContent = 'Set ' + minutesWords(tpValue());
    var soon = W.$('tp-soon');
    W.show(soon, tp.soon || tp.late);
    soon.textContent = tp.late ? minutesWords(tpValue()) + ' is too late. ' + lateWords(new Date())
      : tp.soon ? minutesWords(tpValue()) + ' is too close. Choose a time at least ' + MIN_LEAD_MINUTES + ' minutes from now.' : '';
  }
  function tpChange(apply) { return function () { apply(); tp.soon = false; tp.late = false; drawTimePicker(); }; }
  W.$('tp-hour-up').addEventListener('click', tpChange(function () { tp.hour12 = tp.hour12 === 12 ? 1 : tp.hour12 + 1; }));
  W.$('tp-hour-down').addEventListener('click', tpChange(function () { tp.hour12 = tp.hour12 === 1 ? 12 : tp.hour12 - 1; }));
  W.$('tp-min-up').addEventListener('click', tpChange(function () { tp.minute = (tp.minute + 5) % 60; }));
  W.$('tp-min-down').addEventListener('click', tpChange(function () { tp.minute = (tp.minute - 5 + 60) % 60; }));
  W.$('tp-am').addEventListener('click', tpChange(function () { tp.pm = false; }));
  W.$('tp-pm').addEventListener('click', tpChange(function () { tp.pm = true; }));
  W.$('tp-set').addEventListener('click', function () {
    var value = tpValue();
    if (tp.day && tooLate(pickupAt(tp.day.start, value))) { tp.late = true; tp.soon = false; return drawTimePicker(); }
    if (!tp.day || !isPickupAllowed(pickupAt(tp.day.start, value), new Date())) { tp.soon = true; tp.late = false; return drawTimePicker(); }
    sched.minutes = value;
    sched.day = tp.day.index;
    closeSheets();
    W.show(W.$('sch-err'), false);
    drawSchedule();
  });

  /* the trip for later, priced: Schedule ride */

  function quoteSchedule(pickup, destination, stops, button) {
    var trip = { pickup: pickup, destination: destination, stops: stops };
    api('POST', '/ride-page/schedule/quote', { scheduledFor: sched.at.toISOString(), pickup: pickup, destination: destination, stops: stops }).then(function (answer) {
      if (!sched.at || !local.plan) return;
      var quotedSig = JSON.stringify([sched.at.toISOString(), trip]);
      if (sched.quotedSig !== null && quotedSig !== sched.quotedSig) sched.requestId = newRequestId();
      sched.quotedSig = quotedSig;
      sched.quote = { trip: trip, route: answer.route };
      W.show(W.$('sr-err'), false);
      pushScreen('schedule-confirm');
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('schedule_failed', { code: error.code || String(error.status), step: 'quote' });
      W.$('plan-err').textContent = scheduleRefusal(error);
      W.show(W.$('plan-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  }

  /** The server's refusals of a ride for later, in one short line. */
  function scheduleRefusal(error) {
    var body = (error && error.body) || {};
    // The server's own short words ("Send any message in WhatsApp, then pick a time.", …); these if it sends none.
    if (error.code === 'SCHEDULE_OUTSIDE_WINDOW') {
      refresh();   // the latest time the page offers may have moved
      return error.message || lateWords(new Date(), typeof body.scheduleUntil === 'string' ? Date.parse(body.scheduleUntil) : scheduleLimit());
    }
    if (error.code === 'SCHEDULE_LIMIT') return error.message || 'You can book up to 5 rides ahead.';
    if (error.code === 'SCHEDULE_TOO_CLOSE') return error.message || 'You have a ride within 30 minutes of that time.';
    return error.message;
  }

  function drawScheduleConfirm() {
    var quote = sched.quote;
    if (!quote || !sched.at) return;
    var route = quote.route || {};
    var rows = W.$('sr-rows');
    rows.innerHTML = '';
    var list = [{ kind: 'from', label: 'Pickup', value: route.pickupAddress }]
      .concat((route.stopAddresses || []).map(function (address, index) { return { kind: 'mid', label: 'Stop ' + (index + 1), value: address }; }))
      .concat([{ kind: 'to', label: 'Destination', value: route.destAddress }]);
    list.forEach(function (item, index) {
      var row = el('div', 'route-row');
      var rail = el('span', 'rail');
      rail.appendChild(el('span', 'dot ' + item.kind));
      if (index < list.length - 1) rail.appendChild(el('span', 'rail-line'));
      row.appendChild(rail);
      var text = el('div', 'route-text');
      text.appendChild(el('span', 'route-label', item.label));
      text.appendChild(el('span', 'route-value', item.value || ''));
      row.appendChild(text);
      rows.appendChild(row);
    });
    W.$('sr-km').textContent = Number(route.distanceKm) > 0 ? Number(route.distanceKm).toFixed(1) + ' km' : '';
    W.$('sr-min').textContent = Number(route.durationMin) > 0 ? 'About ' + minutes(route.durationMin) : '';
    W.$('sr-price').textContent = W.naira(route.suggestedFareNgn || 0);
    W.$('sr-when').textContent = pickupWords(sched.at, new Date());
  }
  W.$('sr-back').addEventListener('click', backScreen);
  W.$('sr-edit').addEventListener('click', backScreen);

  W.$('sr-go').addEventListener('click', function () {
    var quote = sched.quote;
    if (busy || !quote || !sched.at) return;
    var button = this;
    var when = sched.at;
    busy = true;
    button.className = 'btn primary busy';
    W.show(W.$('sr-err'), false);
    api('POST', '/ride-page/schedule', {
      scheduledFor: when.toISOString(), pickup: quote.trip.pickup, destination: quote.trip.destination, stops: quote.trip.stops, requestId: sched.requestId
    }).then(function (answer) {
      track('schedule_saved', { stops: quote.trip.stops.length, daysAhead: dayOffset(when, new Date()) });
      if (answer && Array.isArray(answer.scheduled)) scheduledRides = answer.scheduled;
      navHome();
      render();
      say('Ride scheduled for ' + pickupWords(when, new Date()), 'good');
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('schedule_failed', { code: error.code || String(error.status), step: 'book' });
      W.$('sr-err').textContent = scheduleRefusal(error);
      W.show(W.$('sr-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  });

  /* Home's card for the next ride for later, and its sheet (cancel it there) */

  var scheduledRides = [];
  var scheduledLoading = false;
  function loadScheduled() {
    if (scheduledLoading) return;
    scheduledLoading = true;
    api('GET', '/ride-page/scheduled').then(function (answer) {
      scheduledRides = answer && Array.isArray(answer.scheduled) ? answer.scheduled : [];
      if (shownView === 'idle') { drawScheduledCard(); layoutSheet(); }
    }).catch(function (error) {
      if (linkDead(error)) dead(error);
    }).then(function () { scheduledLoading = false; });
  }
  function nextScheduled() {
    var now = Date.now();
    var next = null;
    scheduledRides.forEach(function (ride) {
      if (ride.status !== 'SCHEDULED' && ride.status !== 'DISPATCHING') return;
      var at = Date.parse(ride.scheduledFor);
      if (!isFinite(at) || at < now) return;
      if (!next || at < Date.parse(next.scheduledFor)) next = ride;
    });
    return next;
  }
  /** "tomorrow, 7:30 am", as the app's Home card says it. */
  function homeWhen(date, now) {
    var days = dayOffset(date, now);
    var day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : WEEKDAYS[date.getDay()].slice(0, 3) + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()];
    return day + ', ' + timeWords(date);
  }
  function drawScheduledCard() {
    var ride = nextScheduled();
    var card = W.$('home-scheduled');
    W.show(card, Boolean(ride));
    if (!ride) return;
    W.$('home-scheduled-when').textContent = 'Scheduled ride: ' + homeWhen(new Date(ride.scheduledFor), new Date());
    W.$('home-scheduled-route').textContent = shortPlace(ride.pickupAddress) + ' to ' + shortPlace(ride.destAddress);
  }
  var shownScheduled = null;
  W.$('home-scheduled').addEventListener('click', function () {
    var ride = nextScheduled();
    if (!ride) return;
    shownScheduled = ride;
    W.$('ss-when').textContent = pickupWords(new Date(ride.scheduledFor), new Date());
    W.$('ss-route').textContent = shortPlace(ride.pickupAddress) + ' to ' + shortPlace(ride.destAddress);
    W.$('ss-price').textContent = ride.fareNgn ? W.naira(ride.fareNgn) : '';
    W.show(W.$('ss-err'), false);
    openSheet('sheet-scheduled');
  });
  W.$('ss-cancel').addEventListener('click', function () {
    var ride = shownScheduled;
    if (!ride || busy) return;
    ask({ title: 'Cancel this ride?', text: '', yes: 'Cancel ride', no: 'Keep ride' }).then(function (yes) {
      if (!yes) return;
      busy = true;
      api('POST', '/ride-page/scheduled/' + encodeURIComponent(ride.id) + '/cancel').then(function (answer) {
        track('scheduled_cancelled');
        scheduledRides = answer && Array.isArray(answer.scheduled) ? answer.scheduled : scheduledRides.filter(function (r) { return r.id !== ride.id; });
        say('Scheduled ride cancelled');
      }).catch(function (error) {
        if (linkDead(error)) return dead(error);
        if (error.body && Array.isArray(error.body.scheduled)) scheduledRides = error.body.scheduled;
        say(error.message, 'bad');
      }).then(function () {
        busy = false;
        if (shownView === 'idle') { drawScheduledCard(); layoutSheet(); }
      });
    });
  });

  /* ── saved places: as the app's app/saved-places.tsx ─────────────────── */

  var editing = { place: null, choice: 'Home', name: '', address: null, query: '', results: [], searching: false, error: null, seq: 0, session: null, picking: false };
  var editTimer = null;

  function drawPlaces() {
    var saved = readSaved();
    var holder = W.$('places-list');
    holder.innerHTML = '';
    saved.forEach(function (place) {
      var card = el('div', 'saved-card');
      var top = el('div', 'saved-top');
      var round = el('span', 'result-icon saved');
      round.appendChild(icon(savedIcon(place.label, ICON_PIN)));
      top.appendChild(round);
      var words = el('span', 'result-words');
      words.appendChild(el('strong', '', place.label));
      words.appendChild(el('span', 'two-lines', place.address));
      top.appendChild(words);
      card.appendChild(top);
      var actions = el('div', 'saved-actions');
      var change = el('button', 'text-action', 'Change');
      change.type = 'button';
      change.setAttribute('aria-label', 'Change ' + place.label);
      change.addEventListener('click', function () { openPlaceEdit(place); });
      var remove = el('button', 'text-action danger', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + place.label);
      remove.addEventListener('click', function () {
        ask({ title: 'Remove ' + place.label + '?', text: place.address, yes: 'Remove', no: 'Cancel' }).then(function (yes) {
          if (!yes) return;
          writeSaved(readSaved().filter(function (p) { return p.id !== place.id; }));
          track('saved_place_removed');
          drawPlaces();
        });
      });
      actions.appendChild(change);
      actions.appendChild(remove);
      card.appendChild(actions);
      holder.appendChild(card);
    });
    var full = saved.length >= MAX_SAVED;
    W.show(W.$('places-full'), full);
    W.show(W.$('places-add'), !full);
  }
  W.$('places-back').addEventListener('click', backScreen);
  W.$('places-add').addEventListener('click', function () { openPlaceEdit(null); });

  function takenName(name) {
    return readSaved().some(function (p) { return norm(p.label) === norm(name); });
  }
  function nameChoices() {
    return (takenName('Home') ? [] : ['Home']).concat(takenName('Work') ? [] : ['Work'], ['Other']);
  }
  function openPlaceEdit(place) {
    editing = { place: place, choice: nameChoices()[0], name: '', address: null, query: '', results: [], searching: false, error: null, seq: 0, session: newSession(), picking: false };
    W.$('pe-name').value = '';
    W.$('pe-query').value = '';
    W.show(W.$('pe-name-err'), false);
    pushScreen('place-edit');
    if (place) W.$('pe-query').focus();
  }
  W.$('pe-back').addEventListener('click', backScreen);

  function editName() { return editing.place ? editing.place.label : editing.choice === 'Other' ? W.$('pe-name').value.trim() : editing.choice; }

  function drawPlaceEdit() {
    var place = editing.place;
    W.$('pe-title').textContent = place ? 'Change ' + place.label : 'Add a place';
    W.show(W.$('pe-name-group'), !place);
    var holder = W.$('pe-choices');
    holder.innerHTML = '';
    if (!place) nameChoices().forEach(function (option) {
      var on = option === editing.choice;
      var chip = el('button', 'choice' + (on ? ' on' : ''));
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(on));
      chip.appendChild(icon(savedIcon(option, ICON_PIN)));
      chip.appendChild(el('span', '', option));
      chip.addEventListener('click', function () { editing.choice = option; W.show(W.$('pe-name-err'), false); drawPlaceEdit(); });
      holder.appendChild(chip);
    });
    W.show(W.$('pe-other'), !place && editing.choice === 'Other');

    var picked = editing.address;
    W.show(W.$('pe-picked'), Boolean(picked));
    W.show(W.$('pe-search'), !picked);
    if (picked) {
      var round = W.$('pe-picked-icon');
      round.innerHTML = '';
      round.appendChild(icon(savedIcon(editName(), ICON_PIN)));
      W.$('pe-picked-text').textContent = picked.address;
    }
    W.$('pe-now').textContent = place ? 'Now: ' + place.address : '';
    W.show(W.$('pe-now'), Boolean(place) && !picked);
    W.show(W.$('pe-err'), Boolean(editing.error) && !editing.searching);
    W.$('pe-err').textContent = editing.error || '';
    W.show(W.$('pe-spin'), editing.searching || editing.picking);
    var results = W.$('pe-results');
    results.innerHTML = '';
    var typed = editing.query.trim();
    if (!picked && typed) {
      editing.results.forEach(function (suggestion) {
        results.appendChild(placeRow({ title: suggestion.name, subtitle: suggestion.area }, ICON_PIN, false, function () { pickEditPlace(suggestion); }, 'saved'));
      });
      if (!editing.searching && !editing.error && editing.searchedFor === typed && !editing.results.length) {
        results.appendChild(el('p', 'nothing', 'No place found. Check the spelling.'));
      }
    }
    W.$('pe-save').disabled = !picked || (!place && !editName());
  }

  W.$('pe-name').addEventListener('input', function () { W.show(W.$('pe-name-err'), false); W.$('pe-save').disabled = !editing.address || !editName(); });
  W.$('pe-query').addEventListener('input', function () {
    // A search or a pick still on its way was for the words just typed over.
    editing.seq++;
    editing.searching = false;
    editing.query = this.value;
    editing.error = null;
    clearTimeout(editTimer);
    var query = this.value.trim();
    if (query.length < 2) { editing.searching = false; editing.results = []; editing.seq++; return drawPlaceEdit(); }
    editTimer = setTimeout(function () { searchEditPlaces(query); }, 280);
  });
  function searchEditPlaces(query) {
    var seq = ++editing.seq;
    editing.searching = true;
    drawPlaceEdit();
    api('GET', '/ride-page/suggest?q=' + encodeURIComponent(query) + '&session=' + encodeURIComponent(editing.session)).then(function (answer) {
      if (seq !== editing.seq) return;
      editing.results = ((answer && answer.places) || []).filter(function (p) { return p && p.placeId && p.address; });
      editing.error = null;
    }).catch(function (error) {
      if (seq !== editing.seq) return;
      if (linkDead(error)) return dead(error);
      editing.results = [];
      editing.error = error.message || 'Could not look that up. Try again.';
    }).then(function () {
      if (seq !== editing.seq) return;
      editing.searching = false;
      editing.searchedFor = query;
      if (shownView === 'place-edit') drawPlaceEdit();
    });
  }
  function pickEditPlace(suggestion) {
    if (editing.picking) return;
    clearTimeout(editTimer);
    var seq = ++editing.seq;
    editing.picking = true;
    drawPlaceEdit();
    api('GET', '/ride-page/place?id=' + encodeURIComponent(suggestion.placeId) + '&session=' + encodeURIComponent(editing.session)).then(function (answer) {
      if (seq !== editing.seq) return;
      var spot = answer && answer.place;
      if (!validPoint(spot)) throw { message: 'Could not look that up. Try again.' };
      editing.address = { lat: spot.lat, lng: spot.lng, address: suggestion.address };
      editing.session = newSession();
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      if (seq !== editing.seq) return;
      editing.error = error.message || 'Could not look that up. Try again.';
    }).then(function () {
      editing.picking = false;
      if (shownView === 'place-edit') drawPlaceEdit();
    });
  }
  W.$('pe-clear').addEventListener('click', function () {
    editing.address = null;
    editing.query = '';
    editing.results = [];
    W.$('pe-query').value = '';
    drawPlaceEdit();
    setTimeout(function () { W.$('pe-query').focus(); }, 50);
  });
  W.$('pe-save').addEventListener('click', function () {
    var place = editing.place;
    var name = editName();
    var where = editing.address;
    if (!where) return;
    if (!place) {
      var error = !name ? 'Give this place a name.' : takenName(name) ? 'You already have a place called ' + name + '. Use Change on it instead.' : '';
      if (error) { W.$('pe-name-err').textContent = error; W.show(W.$('pe-name-err'), true); return; }
    }
    var list = readSaved();
    if (place) {
      list = list.map(function (p) { return p.id === place.id ? { id: p.id, label: p.label, address: where.address, lat: where.lat, lng: where.lng } : p; });
    } else {
      if (list.length >= MAX_SAVED) return;
      list.push({ id: Date.now().toString(36) + '-' + list.length, label: name.slice(0, 24), address: where.address, lat: where.lat, lng: where.lng });
    }
    if (!writeSaved(list)) {
      track('saved_place_save_failed');
      say('Could not save this place on this phone.', 'bad');
      return;
    }
    track('saved_place_saved', { label: savedRank({ label: name }) === 2 ? 'other' : norm(name), changed: Boolean(place) });
    backScreen();
  });

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

  /**
   * Auto-book (owner's D4): only when the rider says so. The wallet covers the price: asked once, in a
   * sheet; true / false as answered, null when put away (nothing starts). Wallet short: false, no question.
   */
  var askingAuto = null;
  function askAutoBook(amount) {
    var covers = state && typeof state.balanceNgn === 'number' && state.balanceNgn + 0.004 >= amount && amount > 0;
    if (!covers) return Promise.resolve(false);
    return new Promise(function (resolve) {
      openSheet('sheet-auto');
      W.$('au-title').textContent = 'Auto-book a driver at ' + W.naira(amount) + '?';
      W.$('au-text').textContent = W.naira(amount) + ' will be held from your wallet.';
      askingAuto = resolve;
      track('auto_book_asked', { amountNgn: amount });
    });
  }
  function answerAuto(yes) {
    var answer = askingAuto;
    askingAuto = null;
    closeSheets();
    track('auto_book_answered', { yes: yes });
    if (answer) answer(yes);
  }
  W.$('au-yes').addEventListener('click', function () { answerAuto(true); });
  W.$('au-no').addEventListener('click', function () { answerAuto(false); });

  function searchAgain(amount, fromSheet) {
    if (busy || askingAuto || !(amount > 0)) return;
    askAutoBook(amount).then(function (autoAccept) {
      if (autoAccept === null) return;
      // The question took the price sheet's place: its errors go on the screen now.
      sendSearchAgain(amount, autoAccept, fromSheet && !W.$('sheet-offer').hidden);
    });
  }
  function sendSearchAgain(amount, autoAccept, fromSheet) {
    if (busy) return;
    busy = true;
    track('find_tapped', { amountNgn: amount, again: true, autoAccept: autoAccept });
    api('POST', '/ride-page/search-again', { amountNgn: amount, autoAccept: autoAccept }).then(function (next) {
      if (fromSheet) closeSheets();
      seenOffers = null;
      apply(next);
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('find_failed', { code: error.code || String(error.status), again: true });
      // Where the rider is: the price sheet, No driver accepted, or (moved on meanwhile) a short note.
      var box = fromSheet && !W.$('sheet-offer').hidden ? W.$('offer-err') : shownView === 'nodriver' ? W.$('nd-err') : null;
      if (!box) return say(error.message, 'bad');
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

  /** The trip on Set your price can be changed here: Plan your trip opens with it (as the app's Edit). */
  function priceTrip(s) {
    var p = s && s.phase === 'price' && s.canEditTrip ? s.places : null;
    return p && validPoint(p.pickup) && validPoint(p.destination) && p.pickup.address && p.destination.address ? p : null;
  }
  function backToPlan(s) { return planned && Boolean(priceTrip(s)); }

  function drawPrice(s) {
    drawRoute(s.route);
    rememberPlaces(s.route, s.places);
    var editable = Boolean(priceTrip(s));
    W.show(W.$('route-edit'), editable);
    var card = W.$('price-route');
    card.classList.toggle('editable', editable);
    Array.prototype.forEach.call(card.querySelectorAll('[data-edit]'), function (row) {
      var label = row.querySelector('.route-label');
      if (editable) { row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-label', 'Change ' + (label ? label.textContent.toLowerCase() : 'the trip')); }
      else { row.removeAttribute('role'); row.removeAttribute('tabindex'); row.removeAttribute('aria-label'); }
    });
    // Back: to Plan your trip when the trip was planned here (as the app's price → search), else to WhatsApp.
    var back = W.$('price-back');
    var toPlan = backToPlan(s);
    W.show(back, toPlan || Boolean(s.chatUrl));
    back.setAttribute('href', toPlan ? '#' : s.chatUrl || '#');
    back.setAttribute('aria-label', toPlan ? 'Back to Plan your trip' : 'Back to WhatsApp');
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
  W.$('price-back').addEventListener('click', function (event) {
    if (backToPlan(state)) {
      event.preventDefault();
      track('price_back_tapped', { to: 'plan' });
      return editTrip(null);
    }
    track('chat_link_tapped', { from: 'price' });
  });

  /** Edit, or a place on the route card: Plan your trip with this trip, on that field (none: as it was left). */
  function editTrip(field) {
    var trip = priceTrip(state);
    if (!trip || busy || topScreen()) return;
    openPlan({ trip: trip, over: 'price', field: field });
  }
  W.$('route-edit').addEventListener('click', function () { editTrip('destination'); });
  W.$('price-route').addEventListener('click', function (event) {
    var row = event.target.closest('[data-edit]');
    if (row && priceTrip(state)) editTrip(row.getAttribute('data-edit'));
  });
  W.$('price-route').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var row = event.target.closest('[data-edit]');
    if (!row || !priceTrip(state)) return;
    event.preventDefault();
    editTrip(row.getAttribute('data-edit'));
  });

  W.$('find').addEventListener('click', function () {
    var button = this;
    if (busy || askingAuto) return;
    var amount = W.parseAmount(W.$('price-input').value);
    askAutoBook(amount).then(function (autoAccept) {
      if (autoAccept === null || !state || state.phase !== 'price') return;
      find(button, amount, autoAccept);
    });
  });
  function find(button, amount, autoAccept) {
    if (busy) return;
    busy = true;
    button.className = 'btn primary busy';
    button.textContent = 'Asking drivers…';
    track('find_tapped', { amountNgn: amount, suggestedNgn: state && state.route ? state.route.suggestedFareNgn : 0, minNgn: state ? state.minOfferNgn : 0, autoAccept: autoAccept });
    api('POST', '/ride-page/find', { amountNgn: amount, autoAccept: autoAccept }).then(function (next) {
      seenOffers = null;
      apply(next);
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('find_failed', { code: error.code || String(error.status) });
      W.$('price-err').textContent = error.message;
      W.show(W.$('price-err'), true);
    }).then(function () {
      busy = false;
      button.className = 'btn primary';
      syncPrice();
    });
  }

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
      var leftKey = paying.key;
      paying = null;
      if (wasAdding) { closeSheets(); keepLooking(leftKey); }
    }
    if (payWith && !W.$('sheet-pay').hidden && keys.indexOf(payWith.offer.key) < 0) { payWith = null; closeSheets(); }
    watchAddStep(s);
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
   * While "Add ₦Y" is open: the driver changed the price (the figure to send is
   * wrong now), or the money is in but nothing was booked (the server let the
   * choice go): the step closes, and the offers are there to tap again.
   */
  var MONEY_IN_GAP_MS = 8000;   // looks counted for "money in" are at least this far apart
  var MONEY_IN_LOOKS = 3;       // three of them (16 s and more): a deposit still being booked is never mistaken for one that was not
  function watchAddStep(s) {
    if (!addFor || !paying || paying.key !== addFor.key || !addStepOpen()) { if (!addStepOpen()) addFor = null; return; }
    var offer = (s.offers || []).filter(function (o) { return o.key === addFor.key; })[0];
    if (!offer) return;   // gone: handled above, with "offer ended"
    if (Math.round(offer.priceNgn) !== Math.round(addFor.fareNgn)) {
      // The figure to send is wrong now: let that choice go, and show the new price.
      var key = addFor.key;
      var who = firstName(addFor.name) || 'The driver';
      addFor = null;
      paying = null;
      closeSheets();
      keepLooking(key);
      say(who + ' changed the price');
      return;
    }
    // Money in, but the search still shows offers and nothing booked. Never while the
    // server says a booking is going through, and the driver is never let go here:
    // the deposit may still book them.
    var covered = typeof s.balanceNgn === 'number' && s.balanceNgn + 0.004 >= addFor.fareNgn;
    if (!covered || s.bookingInProgress) { addFor.coveredLooks = 0; addFor.lastLookAt = 0; return; }
    var now = Date.now();
    if (addFor.lastLookAt && now - addFor.lastLookAt < MONEY_IN_GAP_MS) return;
    addFor.lastLookAt = now;
    addFor.coveredLooks = (addFor.coveredLooks || 0) + 1;
    if (addFor.coveredLooks < MONEY_IN_LOOKS) return;
    addFor = null;
    paying = null;
    closeSheets();
    say('Money in. Tap Accept again.');
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

  /* auto-accept (Contract C, D4): on only when the rider said yes at Find; the page only says so */

  function drawAuto(s) {
    // Only when the rider said yes to auto-book (D4).
    // The price the yes was for (autoAcceptPriceNgn): nothing above it is booked.
    var price = Number(s.autoAcceptPriceNgn) > 0 ? Number(s.autoAcceptPriceNgn) : Number(s.offerNgn) || 0;
    var covered = s.autoAccept === true && typeof s.balanceNgn === 'number' && s.balanceNgn + 0.004 >= price && price > 0;
    var line = W.$('auto-line');
    W.show(line, covered);
    line.textContent = covered ? 'A driver at ' + W.naira(price) + ' is booked for you' : '';
  }

  /* the Finding map, as the app's matching screen: the trip, and rings in the middle */

  var findMap = null, findPins = [], findLine = null, findSig = null;

  function drawFindMap(s, searching) {
    var wrap = W.$('find-map-wrap');
    var section = wrap.parentNode;
    var want = searching && Boolean(mapsKey) && !mapsOff();
    W.show(wrap, want);
    section.classList.toggle('with-map', want);
    if (!want) return;
    withMaps(function (g) {
      if (shownView !== 'offers' || wrap.hidden) return;
      var places = placesFor(s);
      var src = Array.isArray(s.line) ? s.line : (s.route && s.route.line);
      var line = Array.isArray(src) ? src.filter(validPoint) : [];
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
    // The price the rider saw: the server books nothing at any other price (OFFER_CHANGED → back to the offers, which show the new one).
    api('POST', '/ride-page/accept', { key: offer.key, method: method, priceNgn: offer.priceNgn }).then(function (next) {
      busy = false;
      paying = null;
      local.confirming = null;
      apply(next);
    }).catch(function (error) {
      busy = false;   // before the redraw: the offers come back live, not greyed out
      if (linkDead(error)) { local.confirming = null; return dead(error); }
      // No answer in time: it may have gone through. Stay on Confirming and ask; the
      // next look decides (confirmed: Driver found; still offers: back to them, quietly).
      if (error.code === 'TIMEOUT' && local.confirming) {
        local.confirming.timedOut = true;
        refresh();
        return;
      }
      local.confirming = null;
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
      // The driver's price moved: show the new one now, not at the next poll.
      if (error.code === 'OFFER_CHANGED') refresh();
    }).then(function () { busy = false; });
  }

  /** Short: the account to send to. The deposit landing confirms the driver, with no further tap. */
  var addFor = null;   // the offer the add-money step is for: { key, fareNgn, name, coveredLooks, lastLookAt }
  function openAdd(offer, info) {
    addFor = { key: offer.key, fareNgn: Number(info.fareNgn) || offer.priceNgn, name: offer.driverName || '', coveredLooks: 0, lastLookAt: 0 };
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
      if (linkDead(error)) return dead(error);
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
      if (linkDead(error)) return dead(error);
      track('price_update_failed', { code: error.code || String(error.status) });
      W.$('offer-err').textContent = error.message;
      W.show(W.$('offer-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  });

  /* cancel: why, as the app asks (app/rider-cancel.tsx) — nothing chosen for them.
   * While drivers are being found (and while one is being confirmed): "Stop looking for a driver?".
   * Once a driver is coming: "Cancel this ride?", with the reasons the server gives (the app's). */

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
  var cancelMode = 'search';   // 'search' | 'ride'
  var cancelling = false;

  /** The matched ride's reasons (state.rideCancelReasons); none: the page cannot cancel the ride. */
  function rideCancelReasons(s) {
    var list = s && Array.isArray(s.rideCancelReasons) ? s.rideCancelReasons : [];
    return list.filter(function (reason) { return typeof reason === 'string' && reason.trim(); });
  }
  function cancelReasons() { return cancelMode === 'ride' ? rideCancelReasons(state) : CANCEL_REASONS; }

  function drawReasons() {
    var holder = W.$('cancel-reasons');
    holder.innerHTML = '';
    cancelReasons().forEach(function (reason) {
      var chosen = cancelReason === reason;
      var row = el('button', 'reason' + (chosen ? ' on' : ''));
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(chosen));
      row.appendChild(el('span', 'radio'));
      row.appendChild(el('span', 'reason-text', reason));
      row.addEventListener('click', function () {
        track('cancel_reason_picked', { reason: reason, mode: cancelMode });
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
    button.textContent = cancelReason ? (cancelMode === 'ride' ? 'Cancel ride' : 'Cancel search') : 'Choose a reason';
    W.show(W.$('cancel-err'), false);
  }
  W.$('cancel-other').addEventListener('input', syncCancel);

  function openCancel(mode) {
    // Confirming a driver keeps the page busy: the search can still be stopped then, as in the app.
    if (cancelling || (busy && !local.confirming)) return;
    if (mode === 'ride' && !rideCancelReasons(state).length) return;
    cancelMode = mode;
    cancelReason = null;
    W.$('cx-title').textContent = mode === 'ride' ? 'Cancel this ride?' : 'Stop looking for a driver?';
    // As the app: how far the driver is, while they are on the way.
    var trip = state && state.trip;
    var eta = mode === 'ride' && trip && (trip.status === 'DRIVER_ASSIGNED' || trip.status === 'DRIVER_EN_ROUTE') ? Number(trip.etaMin) : 0;
    W.$('cx-sub').textContent = eta > 0 ? 'Your driver is ' + eta + (eta === 1 ? ' minute' : ' minutes') + ' away.' : '';
    W.show(W.$('cx-sub'), eta > 0);
    W.$('cancel-other').value = '';
    W.show(W.$('cancel-other-field'), false);
    drawReasons();
    syncCancel();
    track('cancel_opened', { mode: mode, from: shownView });
    openSheet('sheet-cancel');
  }
  W.$('cancel-search').addEventListener('click', function () { openCancel('search'); });
  W.$('cf-cancel').addEventListener('click', function () { openCancel('search'); });
  W.$('fd-cancel').addEventListener('click', function () { openCancel('ride'); });
  W.$('d-cancel').addEventListener('click', function () { openCancel('ride'); });

  W.$('cancel-yes').addEventListener('click', function () {
    if (cancelling || !cancelReason || (busy && !local.confirming)) return;
    var button = this;
    var mode = cancelMode;
    var ownBusy = !busy;
    cancelling = true;
    if (ownBusy) busy = true;
    button.className = 'btn danger busy';
    var body = { reason: cancelReason };
    var words = W.$('cancel-other').value.trim();
    if (cancelReason === OTHER && words) body.detail = words;
    api('POST', mode === 'ride' ? '/ride-page/cancel-ride' : '/ride-page/cancel', body).then(function (next) {
      track(mode === 'ride' ? 'ride_cancel_confirmed' : 'cancel_confirmed', body);
      closeSheets();
      if (mode === 'ride') local.rideCancelledHere = true;
      else local.cancelledHere = true;
      apply(next);
      if (mode === 'search') say('Search cancelled. Nothing was charged.');
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track(mode === 'ride' ? 'ride_cancel_failed' : 'cancel_failed', { code: error.code || String(error.status) });
      W.$('cancel-err').textContent = error.message;
      W.show(W.$('cancel-err'), true);
      // The ride moved on meanwhile (a driver confirmed, the trip started or ended): show where it is.
      if (error.status === 409) refresh();
    }).then(function () {
      cancelling = false;
      if (ownBusy) busy = false;
      button.className = 'btn danger';
    });
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
        if (linkDead(error)) return dead(error);
        say(error.message, 'bad');
      }).then(function () { busy = false; });
    });
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
    W.show(W.$('fd-cancel'), rideCancelReasons(s).length > 0);
  }

  W.$('fd-track').addEventListener('click', function () {
    if (!state) return;
    track('track_driver_tapped');
    markFound(foundId(state));
    render();
  });

  /* ── 3 · confirmed → live trip ────────────────────────────────────────── */

  var tripLineSig = null;
  var tripMap = null, carMarker = null, tripLine = null, tripPins = [], tripFor = null, followCar = true, mapFitted = false;

  /** A new ride on the same page: the last one's pins, road and car go, and the map frames afresh. */
  function clearTripMap() {
    tripPins.forEach(function (pin) { pin.setMap(null); });
    tripPins = [];
    if (tripLine) { tripLine.setMap(null); tripLine = null; }
    tripLineSig = null;
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
    if (!mapsKey || mapsOff() || !validPoint(t.pickup) || !validPoint(t.destination)) { W.show(W.$('map-card'), false); return; }
    W.show(W.$('map-card'), true);

    withMaps(function (g) {
      if (shownView !== 'confirmed') return;
      if (!tripMap) {
        tripMap = makeMap(g, W.$('map'), t.pickup, 14);
        // Once they move the map themselves, stop dragging it back to the car.
        tripMap.addListener('dragstart', function () { followCar = false; });
      }
      // A changed route (another destination) draws its pins afresh too.
      var rideKey = ((state && foundId(state)) || (t.tripId || '')) + '|' + t.destination.lat + ',' + t.destination.lng;
      if (tripFor !== rideKey) {
        clearTripMap();
        tripFor = rideKey;
        tripPins = [new HtmlMarker(tripMap, t.pickup, 'pin-pickup'), new HtmlMarker(tripMap, t.destination, 'pin-dest')];
        tripMap.setCenter(t.pickup);
      }
      // The planned road, once: pickup to destination through the stops.
      var line = Array.isArray(t.line) ? t.line.filter(validPoint) : [];
      var lineSig = line.length ? line.length + '|' + line[0].lat + ',' + line[0].lng + '|' + line[line.length - 1].lat + ',' + line[line.length - 1].lng + '|' + line[Math.floor(line.length / 2)].lat : '';
      if (tripLine && lineSig !== tripLineSig) { tripLine.setMap(null); tripLine = null; }
      if (!tripLine && line.length > 1) { tripLine = routeLine(g, tripMap, line); tripLineSig = lineSig; }

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
    drawTripFoot(s);
  }

  /* the trip's lower part, as the app's: how much is done, Add or change stop, then Cancel ride · Support · Emergency */

  /** The trip's places with their spots (state.places), for "Change your route"; null: not offered. */
  function routeTrip(s) {
    var p = s && s.phase === 'confirmed' ? s.places || (s.route && s.route.places) : null;
    if (!p || !validPoint(p.pickup) || !validPoint(p.destination) || !p.pickup.address || !p.destination.address) return null;
    var stops = Array.isArray(p.stops) ? p.stops : [];
    // More stops than may be sent back (state.maxStops): the route cannot be changed here.
    if (stops.length > maxStops()) return null;
    return { pickup: p.pickup, destination: p.destination, stops: stops };
  }

  function drawTripFoot(s) {
    var t = s.trip || {};
    // How much of the planned distance has been driven, when the server says (0..1).
    var done = t.status === 'IN_PROGRESS' && typeof t.progress === 'number' && isFinite(t.progress) ? Math.min(1, Math.max(0, t.progress)) : null;
    var track_ = W.$('d-progress');
    W.show(track_, done !== null);
    if (done !== null) {
      W.$('d-progress-fill').style.width = Math.round(done * 100) + '%';
      track_.setAttribute('aria-valuenow', String(Math.round(done * 100)));
      track_.setAttribute('aria-label', Math.round(done * 100) + ' percent of the trip done');
    }

    var trip = routeTrip(s);
    W.show(W.$('d-stops'), Boolean(trip));
    var extra = trip ? trip.stops.length : 0;
    W.$('d-stops-count').textContent = extra > 0 ? extra + ' extra stop' + (extra === 1 ? '' : 's') + ' on this trip' : '';
    W.show(W.$('d-stops-count'), extra > 0);

    W.show(W.$('d-cancel'), rideCancelReasons(s).length > 0);
    var support = supportLink(s.supportContact);
    var link = W.$('d-support');
    W.show(link, Boolean(support));
    if (support) link.setAttribute('href', support.href || '#');
    drawSos(s);
    W.show(W.$('d-trip-foot'), rideCancelReasons(s).length > 0 || Boolean(support) || sosOffered(s));
  }

  W.$('d-stops').addEventListener('click', function () {
    var trip = routeTrip(state);
    if (!trip || busy || topScreen()) return;
    openPlan({ trip: trip, mode: 'route', over: 'confirmed' });
  });

  /**
   * Support, as the Quick Actions' (state.supportContact, free text): a link opens it (WhatsApp for
   * a wa.me link or a number said to be on WhatsApp, the phone for a number, mail for an address);
   * anything else is shown as it is.
   */
  function supportLink(contact) {
    if (typeof contact !== 'string' || !contact.trim()) return null;
    var text = contact.trim();
    var url = text.match(/https:\/\/[^\s]+/);
    if (url) return { href: url[0] };
    var mail = text.match(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
    var phone = text.match(/\+?\d[\d\s-]{8,}\d/);
    if (phone) {
      var digits = phone[0].replace(/[^\d+]/g, '');
      if (/whatsapp|wa\.me/i.test(text)) {
        var intl = digits.replace(/^\+/, '').replace(/^0(\d{10})$/, '234$1');
        return { href: 'https://wa.me/' + intl };
      }
      return { href: 'tel:' + digits };
    }
    if (mail) return { href: 'mailto:' + mail[0] };
    return { href: null, text: text };
  }
  W.$('d-support').addEventListener('click', function (event) {
    track('support_tapped');
    var support = supportLink(state && state.supportContact);
    if (support && !support.href) { event.preventDefault(); say(support.text); }
  });

  /* Emergency, as the app's (components/emergency-button.tsx): the sheet asks what is happening, then the alert goes */

  // The app's kinds and words (lib/safety.ts describeAlertKind); the server's list (state.sosKinds) wins.
  var SOS_LABELS = { SOS: 'I need help now', UNSAFE_DRIVING: 'Unsafe driving', ROUTE_DEVIATION: 'We are off the route', ACCIDENT: 'There has been an accident', MEDICAL: 'Medical emergency' };
  var SOS_KEY = 'wheelers.ride.sos';
  var sosLive = readStore('sessionStorage', SOS_KEY) || {};   // { rideId: { kind, at } } — raised from this page
  var sosStep = 'ask';   // 'ask' | 'sent' | 'live'
  var sosSending = false;
  /** Offered while there is a trip and the server takes the alert (a newer one sends these fields). */
  function sosOffered(s) { return Boolean(s && s.phase === 'confirmed' && ('supportContact' in s || 'rideCancelReasons' in s || 'sosActive' in s)); }
  /** [{ kind, label }]: the server's, in its order (strings or { kind, label }); none sent: "I need help now" only. */
  function sosKinds(s) {
    var list = s && Array.isArray(s.sosKinds) ? s.sosKinds : [];
    var kinds = list.map(function (item) {
      var kind = typeof item === 'string' ? item : item && typeof item.kind === 'string' ? item.kind : '';
      var label = item && typeof item.label === 'string' && item.label ? item.label : SOS_LABELS[kind] || '';
      return kind && label ? { kind: kind, label: label } : null;
    }).filter(Boolean);
    return kinds.length ? kinds : [{ kind: 'SOS', label: SOS_LABELS.SOS }];
  }
  function sosLabel(kind) {
    var found = sosKinds(state).filter(function (k) { return k.kind === kind; })[0];
    return found ? found.label : SOS_LABELS[kind] || SOS_LABELS.SOS;
  }
  function sosIsLive(s) {
    if (s && typeof s.sosActive === 'boolean') return s.sosActive;
    return Boolean(s && s.rideId && sosLive[s.rideId]);
  }
  /** The open alert: { kind, at } from the server (sosKind, sosSentAt), else what this page sent. */
  function sosOpen(s) {
    var mine = s && s.rideId && typeof sosLive[s.rideId] === 'object' ? sosLive[s.rideId] : {};
    return { kind: (s && typeof s.sosKind === 'string' && s.sosKind) || mine.kind || 'SOS', at: (s && typeof s.sosSentAt === 'string' && s.sosSentAt) || mine.at || null };
  }
  function setSosLive(on, kind) {
    if (!state) return;
    // The button shows the truth at once, not at the next look.
    state.sosActive = on;
    if (on) { state.sosKind = kind; state.sosSentAt = new Date().toISOString(); }
    if (!state.rideId) return;
    sosLive = {};
    if (on) sosLive[state.rideId] = { kind: kind, at: state.sosSentAt };
    writeStore('sessionStorage', SOS_KEY, sosLive);
  }
  /** As the app: "just now", "4 min ago", "1 hr ago". */
  function timeAgo(iso) {
    var then = Date.parse(iso || '');
    if (!isFinite(then)) return 'just now';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    var mins = Math.round(seconds / 60);
    return mins < 60 ? mins + ' min ago' : Math.round(mins / 60) + ' hr ago';
  }
  function drawSos(s) {
    var button = W.$('d-sos');
    W.show(button, sosOffered(s));
    var live = sosIsLive(s);
    button.classList.toggle('live', live);
    W.$('d-sos-text').textContent = live ? 'Alert active' : 'Emergency';
    button.setAttribute('aria-label', live ? 'Emergency alert is active' : 'Emergency');
  }
  var ICON_ARROW = ['M5 12h14', 'M13 6l6 6-6 6'];
  function drawSosSheet(alreadyOpen) {
    var step = sosStep;
    W.$('sos-title').textContent = step === 'sent' ? 'Help is on the way' : step === 'live' ? 'Your alert is active' : 'Get help now';
    var sub = step === 'sent'
      ? (alreadyOpen ? 'Our safety team is already on your alert. Stay on the line if you can.' : 'Our safety team will contact you. If you are in immediate danger, call 112 now.')
      : step === 'live' ? 'Our safety team has your details and is working on it.'
      : 'Tell us what is happening. Your location and trip details go with the alert.';
    W.$('sos-sub').textContent = sub;
    W.show(W.$('sos-sub'), true);
    // What is happening: "I need help now" first and red, then the others.
    var holder = W.$('sos-kinds');
    holder.innerHTML = '';
    W.show(holder, step === 'ask');
    if (step === 'ask') sosKinds(state).forEach(function (k, index) {
      var row = el('button', 'sos-kind' + (index === 0 ? ' first' : ''));
      row.type = 'button';
      row.disabled = sosSending;
      row.appendChild(el('span', 'sos-kind-text', k.label));
      row.appendChild(icon(ICON_ARROW));
      row.addEventListener('click', function () { sendSos(k.kind); });
      holder.appendChild(row);
    });
    var open = step === 'live' ? sosOpen(state) : null;
    W.show(W.$('sos-sent'), Boolean(open));
    if (open) W.$('sos-sent-text').textContent = sosLabel(open.kind) + ' — sent ' + timeAgo(open.at);
    W.show(W.$('sos-cancel'), step === 'live');
    W.$('sos-close').textContent = step === 'sent' ? 'OK' : 'Close';
  }
  W.$('d-sos').addEventListener('click', function () {
    if (!state) return;
    sosStep = sosIsLive(state) ? 'live' : 'ask';
    W.show(W.$('sos-err'), false);
    drawSosSheet(false);
    track('sos_opened', { live: sosStep === 'live' });
    openSheet('sheet-sos');
  });
  W.$('sos-call').addEventListener('click', function () { track('sos_call_112_tapped'); });
  function sendSos(kind) {
    if (sosSending) return;
    sosSending = true;
    W.show(W.$('sos-err'), false);
    drawSosSheet(false);
    api('POST', '/ride-page/sos', { kind: kind }).then(function (answer) {
      track('sos_sent', { kind: kind, alreadyOpen: Boolean(answer && answer.alreadyOpen) });
      setSosLive(true, kind);
      sosStep = 'sent';
      if (!W.$('sheet-sos').hidden) drawSosSheet(Boolean(answer && answer.alreadyOpen));
      if (state && state.phase === 'confirmed') drawSos(state);
      refresh();
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('sos_failed', { kind: kind, code: error.code || String(error.status) });
      // As the app: the alert did not go; 112 is one tap above.
      W.$('sos-err').textContent = 'We could not send your alert. Call 112 now if you are in danger.';
      W.show(W.$('sos-err'), true);
    }).then(function () {
      sosSending = false;
      if (sosStep === 'ask' && !W.$('sheet-sos').hidden) drawSosSheet(false);
    });
  }
  W.$('sos-cancel').addEventListener('click', function () {
    if (sosSending) return;
    sosSending = true;
    W.show(W.$('sos-err'), false);
    api('POST', '/ride-page/sos/cancel').then(function () {
      track('sos_cancelled');
      setSosLive(false);
      if (state && state.phase === 'confirmed') drawSos(state);
      // Only the Emergency sheet: an answer arriving late never closes another one.
      if (!W.$('sheet-sos').hidden) closeSheets();
      refresh();
    }).catch(function (error) {
      if (linkDead(error)) return dead(error);
      track('sos_cancel_failed', { code: error.code || String(error.status) });
      W.$('sos-err').textContent = 'Our safety team is already handling this alert. They will call you.';
      W.show(W.$('sos-err'), true);
    }).then(function () { sosSending = false; });
  });

  /* ── the loop ─────────────────────────────────────────────────────────── */

  /**
   * Plan your trip over Set your price (the trip to change) or over the trip (its route to change):
   * open while the phase it was opened over lasts. Over Home, every screen stays while the home does.
   */
  function planOver(phase) {
    return nav.length === 1 && nav[0] === 'plan' && plan.over === phase && (plan.mode === 'route') === (phase === 'confirmed');
  }
  /** The screens open now still belong over this phase. */
  function screensFit(phase) {
    if (!nav.length) return true;
    if (phase === 'idle') return !(nav.indexOf('plan') >= 0 && plan.mode === 'route');
    return planOver(phase);
  }

  /** The screen for the state, with what only this page knows on top. */
  function viewFor(s) {
    if (s.phase === 'idle') {
      // A screen over Home: Plan your trip, Later, saved places.
      if (topScreen()) return topScreen();
      var last = lastSearchOf(s);
      if (last && noDriverClosed !== noDriverSig(last)) return 'nodriver';
      return 'idle';
    }
    if (s.phase === 'offers') return local.confirming ? 'confirming' : 'offers';
    if (s.phase === 'confirmed') return planOver('confirmed') ? 'plan' : showFound(s) ? 'found' : 'confirmed';
    if (s.phase === 'price') return planOver('price') ? 'plan' : 'price';
    return 'idle';
  }

  function render() {
    if (!state || shownView === 'fatal' || shownView === 'expired') return;
    var view = viewFor(state);
    var changed = view !== shownView;
    if (changed) {
      shownView = view;
      W.showOnly(view);
      document.body.classList.toggle('on-home', view === 'idle');
    }
    if (view === 'idle') drawHome(state, changed);
    else if (view === 'plan') drawPlan();
    // These redraw themselves as the rider taps; a poll does not rebuild them under a finger.
    else if (view === 'schedule') { if (changed) drawSchedule(); }
    else if (view === 'schedule-confirm') { if (changed) drawScheduleConfirm(); }
    else if (view === 'places') { if (changed) drawPlaces(); }
    else if (view === 'place-edit') { if (changed) drawPlaceEdit(); }
    else if (view === 'nodriver') drawNoDriver(state, changed);
    else if (view === 'price') drawPrice(state);
    else if (view === 'offers') drawSent(state);
    else if (view === 'confirming') drawConfirming();
    else if (view === 'found') drawFound(state);
    else if (view === 'confirmed') drawConfirmed(state);
  }

  // Every state shown is numbered. A poll's number is taken when it is sent; an
  // action's answer (accept, cancel, …) is the newest truth when it arrives. An
  // answer to a poll sent before the last state shown is older than it: dropped.
  var stateSeq = 0;
  var appliedSeq = 0;
  function apply(next) {
    appliedSeq = ++stateSeq;
    applyState(next);
  }

  function applyState(next) {
    if (!next || typeof next.phase !== 'string') return;
    // The link's time is up (or it was refused): an answer arriving late changes nothing.
    if (shownView === 'expired' || shownView === 'fatal') return;
    var before = state && state.phase;
    state = next;
    // Each answer carries the map key (null: no maps on this server).
    mapsKey = typeof next.mapsKey === 'string' && next.mapsKey ? next.mapsKey : null;
    if (next.phase !== 'offers') { seenOffers = null; paying = null; declined = null; offerSnapshot = null; local.confirming = null; addFor = null; }
    // An accept that timed out, and the server still shows the offers: back to them, quietly.
    if (next.phase === 'offers' && local.confirming && local.confirming.timedOut) { local.confirming = null; paying = null; }
    // The trip moved on while a screen was open over Home (a price, a search, a ride), or the trip
    // whose route was being changed ended: their history entries go too, so Back works.
    if (!screensFit(next.phase)) navHome();
    // Planned on this page: until the trip is booked or let go.
    if (next.phase === 'idle' || next.phase === 'confirmed') setPlanned(false);

    if (before !== next.phase) {
      track('phase_shown', { from: before || 'none' });
      if (next.phase !== 'offers') closeSheets();
      if (before === 'confirmed' && next.phase === 'idle') local.endedNote = local.rideCancelledHere ? 'Ride cancelled' : 'Trip ended';
      if (before === 'offers' && next.phase === 'idle' && !lastSearchOf(next) && !local.cancelledHere) say('Search ended');
      if (next.phase !== 'idle') local.endedNote = null;
      local.cancelledHere = false;
      local.rideCancelledHere = false;
    }
    // Back from a search to change the trip: the box holds the price they had out (raised or not).
    if (before === 'offers' && next.phase === 'price' && next.lastOfferNgn) W.$('price-input').value = Number(next.lastOfferNgn).toLocaleString('en-NG');
    render();
  }

  function refresh() {
    var seq = ++stateSeq;
    return api('GET', '/ride-page/state').then(function (next) {
      if (seq < appliedSeq) return;
      appliedSeq = seq;
      applyState(next);
    }).catch(function (error) {
      if (linkDead(error)) dead(error);
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
