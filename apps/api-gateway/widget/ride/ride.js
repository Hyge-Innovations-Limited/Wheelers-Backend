/* The Wheelers price page. No dependencies, no build step.
 *
 * ONE job before a driver is found: name a price (and change it). Drivers'
 * offers are NOT shown here — they arrive in the WhatsApp chat, where a phone
 * buzzes, and are taken there with a tap. Money is not handled here either:
 * a short wallet is dealt with on the deposit page, from the chat. Once a
 * driver is confirmed this same link becomes the live trip map.
 *
 * It holds no booking state of its own: every few seconds it asks the server
 * where the booking is and redraws, so leaving, refreshing or coming back an
 * hour later shows the truth. */
(function () {
  'use strict';
  var W = window.Wheelers;
  var POLL_MS = 3000;        // while bidding: offers should feel instant
  var TRACK_MS = 5000;       // while tracking: a car does not move far in five seconds

  var state = null;          // the last thing the server told us
  var seenOffers = null;     // how many offers the chat had at the last look — null until the first
  var polling = null;
  var busy = false;

  if (!W.takeToken()) { W.fatal('This link is not valid.'); return; }

  /* ── toasts: a queue, so three changes in one poll are three notes ─────── */

  function say(message, tone) {
    var holder = W.$('toasts');
    var el = document.createElement('div');
    el.className = 'toast-item' + (tone ? ' ' + tone : '');
    el.textContent = message;
    holder.appendChild(el);
    while (holder.children.length > 3) holder.removeChild(holder.firstChild);
    setTimeout(function () { el.className += ' leaving'; }, 3400);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3800);
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
  function roundTo(value, step) { return Math.round(value / step) * step; }
  function minutes(n) { return n + ' min'; }

  function drawRoute(route) {
    drawStops(route.stopAddresses || []);
    setText('[data-route="pickup"]', route.pickupAddress);
    setText('[data-route="dest"]', route.destAddress);
    setText('[data-route="distance"]', (Number(route.distanceKm) || 0).toFixed(1) + ' km');
    setText('[data-route="time"]', '~' + minutes(route.durationMin));
  }

  /** The places on the way, between the pickup row and the destination row of every trip card. */
  var stopsDrawn = null;
  function drawStops(stops) {
    var signature = stops.join('|');
    if (stopsDrawn === signature) return;
    stopsDrawn = signature;
    Array.prototype.forEach.call(document.querySelectorAll('.stop.mid'), function (row) { row.parentNode.removeChild(row); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-route="dest"]'), function (dest) {
      var destRow = dest.parentNode;
      stops.forEach(function (address) {
        var row = el('div', 'stop mid');
        row.appendChild(el('span', 'dot mid'));
        row.appendChild(el('span', 'where', address));
        destRow.parentNode.insertBefore(row, destRow);
      });
    });
  }

  /** Suggested, a little lower, a little higher — never under the floor. */
  function drawChips(holderId, inputId, base, floor, onPick) {
    var holder = W.$(holderId);
    holder.innerHTML = '';
    var options = [
      { label: 'Lowest', value: floor },
      { label: 'Suggested', value: base },
      { label: '+10%', value: roundTo(base * 1.1, 50) },
      { label: '+20%', value: roundTo(base * 1.2, 50) }
    ];
    var seen = {};
    options.forEach(function (option) {
      if (!(option.value >= floor) || seen[option.value]) return;
      seen[option.value] = true;
      var button = el('button');
      button.type = 'button';
      button.setAttribute('data-amount', String(option.value));
      button.appendChild(el('small', '', option.label));
      button.appendChild(document.createTextNode(W.naira(option.value)));
      button.addEventListener('click', function () {
        W.$(inputId).value = Number(option.value).toLocaleString('en-NG');
        onPick();
      });
      holder.appendChild(button);
    });
  }
  function markChips(holderId, amount) {
    var chips = W.$(holderId).children;
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = Number(chips[i].getAttribute('data-amount')) === amount ? 'on' : '';
    }
  }

  /* ── sheets ───────────────────────────────────────────────────────────── */

  function openSheet(id) {
    closeSheets();
    W.show(W.$('overlay'), true);
    W.show(W.$(id), true);
  }
  function closeSheets() {
    W.show(W.$('sheet-offer'), false);
    W.show(W.$('overlay'), false);
  }
  W.$('overlay').addEventListener('click', closeSheets);
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (button) {
    button.addEventListener('click', closeSheets);
  });

  /* ── 1 · name your price ──────────────────────────────────────────────── */

  var priceDrawnFor = null;

  function drawPrice(s) {
    drawRoute(s.route);
    var signature = s.route.pickupAddress + '|' + s.route.destAddress + '|' + s.route.suggestedFareNgn;
    if (priceDrawnFor !== signature) {           // a fresh quote — not every poll, or typing would be wiped
      priceDrawnFor = signature;
      drawChips('price-chips', 'price-input', s.route.suggestedFareNgn, s.minOfferNgn, syncPrice);
      if (!W.$('price-input').value) W.$('price-input').value = Number(s.route.suggestedFareNgn).toLocaleString('en-NG');
    }
    syncPrice();
  }

  function syncPrice() {
    if (!state || state.phase !== 'price') return;
    var amount = W.parseAmount(W.$('price-input').value);
    var floor = state.minOfferNgn;
    var hint = W.$('price-hint');
    W.show(W.$('price-err'), false);
    markChips('price-chips', amount);

    if (amount > 0 && amount < floor) {
      hint.className = 'hint bad';
      hint.textContent = 'The lowest price for this trip is ' + W.naira(floor) + '.';
    } else {
      hint.className = 'hint';
      hint.textContent = 'Suggested ' + W.naira(state.route.suggestedFareNgn) + ' · lowest ' + W.naira(floor);
    }
    W.$('find').disabled = !(amount >= floor);
  }
  W.$('price-input').addEventListener('input', function () { W.formatAmountInput(this); syncPrice(); });

  W.$('find').addEventListener('click', function () {
    var button = this;
    if (busy) return;
    busy = true;
    button.className = 'btn primary busy';
    button.firstChild.textContent = 'Asking drivers… ';
    W.api('POST', '/ride-page/find', { amountNgn: W.parseAmount(W.$('price-input').value) }).then(function (next) {
      seenOffers = null;
      apply(next);
      say('Your price is out. Watch your WhatsApp chat.', 'good');
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      W.$('price-err').textContent = error.message;
      W.show(W.$('price-err'), true);
    }).then(function () {
      busy = false;
      button.className = 'btn primary';
      button.firstChild.textContent = 'Find drivers ';
    });
  });

  /* ── 2 · the price is out — offers arrive in the chat ───────────────────── */

  function drawSent(s) {
    drawRoute(s.route);

    var mine = W.$('my-offer');
    var shown = mine.getAttribute('data-value');
    mine.textContent = W.naira(s.offerNgn);
    mine.setAttribute('data-value', String(s.offerNgn));
    if (shown && shown !== String(s.offerNgn)) {
      mine.parentNode.parentNode.className = 'mine';
      void mine.offsetWidth;                                  // restart the flash
      mine.parentNode.parentNode.className = 'mine flash';
    }

    // Never who or how much — only that the chat has something for them.
    var count = Number(s.offerCount) || 0;
    W.$('sent-title').textContent = count === 0 ? 'Asking drivers near you…'
      : count === 1 ? '1 offer is waiting in your chat' : count + ' offers are waiting in your chat';
    W.$('sent-text').textContent = count === 0
      ? 'Each offer arrives as a WhatsApp message. Tap the one you want, right there in the chat.'
      : 'Go back to WhatsApp and tap the driver you want.';
    if (seenOffers !== null && count > seenOffers) say('New offer — it’s in your WhatsApp chat', 'good');
    seenOffers = count;

    var back = W.$('back-to-chat');
    W.show(back, Boolean(s.chatUrl));
    if (s.chatUrl) back.setAttribute('href', s.chatUrl);
    W.$('close-hint').textContent = s.chatUrl
      ? 'WhatsApp will buzz you when a driver responds — you don’t need to keep this page open.'
      : 'You can close this page now — WhatsApp will buzz you when a driver responds.';
  }

  /* change the bid */

  W.$('change-offer').addEventListener('click', function () {
    if (!state || state.phase !== 'offers') return;
    W.$('offer-input').value = Number(state.offerNgn).toLocaleString('en-NG');
    W.show(W.$('offer-err'), false);
    drawChips('offer-chips', 'offer-input', state.route.suggestedFareNgn, state.minOfferNgn, function () {
      markChips('offer-chips', W.parseAmount(W.$('offer-input').value));
    });
    markChips('offer-chips', state.offerNgn);
    openSheet('sheet-offer');
  });
  W.$('offer-input').addEventListener('input', function () {
    W.formatAmountInput(this);
    markChips('offer-chips', W.parseAmount(this.value));
  });

  W.$('offer-save').addEventListener('click', function () {
    var button = this;
    var amount = W.parseAmount(W.$('offer-input').value);
    if (busy) return;
    if (state && amount === state.offerNgn) return closeSheets();
    busy = true;
    button.className = 'btn primary busy';
    W.api('POST', '/ride-page/offer', { amountNgn: amount }).then(function (next) {
      closeSheets();
      apply(next);
      say('Offer updated to ' + W.naira(amount) + '. Drivers notified.', 'good');
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      W.$('offer-err').textContent = error.message;
      W.show(W.$('offer-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  });

  /* cancel */

  W.$('cancel-search').addEventListener('click', function () {
    if (busy || !window.confirm('Stop looking for a driver? Nothing has been charged.')) return;
    busy = true;
    W.api('POST', '/ride-page/cancel').then(function (next) {
      apply(next);
      W.$('idle-text').textContent = 'Search cancelled — nothing was charged. Send your trip to the Wheelers bot whenever you need a ride.';
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      say(error.message, 'bad');
    }).then(function () { busy = false; });
  });

  /* ── 3 · confirmed → live trip ────────────────────────────────────────── */

  var map = null, carMarker = null, routeLine = null, followCar = true, mapFitted = false;

  var TRIP_COPY = {
    DRIVER_ASSIGNED: ['Ride confirmed', 'Your driver is ', 'on the way'],
    DRIVER_EN_ROUTE: ['Ride confirmed', 'Your driver is ', 'on the way'],
    ARRIVED: ['Your driver is here', 'Your driver has ', 'arrived'],
    IN_PROGRESS: ['Trip in progress', 'You’re ', 'on your way']
  };

  function pin(className, html) {
    return L.divIcon({ className: '', html: '<span class="pin ' + className + '">' + (html || '') + '</span>', iconSize: [42, 42], iconAnchor: [21, 21] });
  }
  function smallPin(className) {
    return L.divIcon({ className: '', html: '<span class="pin ' + className + '"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function drawTrip(trip) {
    var copy = TRIP_COPY[trip.status] || TRIP_COPY.DRIVER_ASSIGNED;
    W.$('trip-eyebrow').textContent = copy[0];
    var title = W.$('trip-title');
    title.innerHTML = '';
    title.appendChild(document.createTextNode(copy[1]));
    title.appendChild(el('em', '', copy[2]));

    // No Leaflet (an ancient browser, a blocked script)? The card below still says everything.
    if (typeof L === 'undefined') return;
    W.show(W.$('map-card'), true);

    if (!map) {
      map = L.map('map', { zoomControl: false, attributionControl: true }).setView([trip.pickup.lat, trip.pickup.lng], 14);
      L.tileLayer(trip.map.tileUrl, { attribution: trip.map.attribution, maxZoom: 19 }).addTo(map);
      L.marker([trip.pickup.lat, trip.pickup.lng], { icon: smallPin('pin-pickup'), keyboard: false }).addTo(map).bindTooltip('Pickup');
      L.marker([trip.destination.lat, trip.destination.lng], { icon: smallPin('pin-dest'), keyboard: false }).addTo(map).bindTooltip('Destination');
      // Once they move the map themselves, stop dragging it back to the car.
      map.on('dragstart', function () { followCar = false; });
    }
    // The planned road, once: pickup to destination through the stops.
    if (!routeLine && trip.line && trip.line.length > 1) {
      routeLine = L.polyline(trip.line.map(function (p) { return [p.lat, p.lng]; }), { color: '#F97316', weight: 5, opacity: 0.85 }).addTo(map);
    }

    var position = trip.driverPosition;
    if (position) {
      if (!carMarker) {
        carMarker = L.marker([position.lat, position.lng], { icon: pin('pin-car', 'CAR'), keyboard: false, zIndexOffset: 1000 }).addTo(map);
        if (carMarker._icon) carMarker._icon.className += ' car-marker';
      } else {
        carMarker.setLatLng([position.lat, position.lng]);
      }
      var carIcon = carMarker._icon && carMarker._icon.querySelector('.pin-car');
      if (carIcon) carIcon.className = 'pin pin-car' + (trip.positionFresh ? '' : ' stale');

      if (!mapFitted) {
        // Open on the car AND where it is heading, so the first look answers "how far?".
        var goal = trip.status === 'IN_PROGRESS' ? trip.destination : trip.pickup;
        map.fitBounds(L.latLngBounds([[position.lat, position.lng], [goal.lat, goal.lng]]), { padding: [50, 50], maxZoom: 16 });
        mapFitted = true;
      } else if (followCar) {
        map.panTo([position.lat, position.lng], { animate: true, duration: 1 });
      }
    }

    var badge = W.$('map-eta');
    var badgeText = trip.status === 'ARRIVED' ? 'Driver is outside'
      : trip.etaMin ? (trip.status === 'IN_PROGRESS' ? 'Arriving in ' : 'Pickup in ') + minutes(trip.etaMin) : '';
    badge.textContent = badgeText;
    W.show(badge, Boolean(badgeText));

    var stale = W.$('map-stale');
    var showStale = Boolean(position) && !trip.positionFresh && trip.positionAgeSeconds !== null;
    W.show(stale, showStale);
    if (showStale) stale.textContent = 'Your driver’s signal is weak — this position is from ' + Math.max(1, Math.round(trip.positionAgeSeconds / 60)) + ' min ago.';
    if (!position) { W.show(stale, true); stale.textContent = 'Waiting for your driver’s location…'; }
  }

  W.$('map-recentre').addEventListener('click', function () {
    followCar = true;
    if (map && carMarker) map.setView(carMarker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
  });

  function drawConfirmed(s) {
    if (s.trip) drawTrip(s.trip);
    var driver = s.driver || {};
    W.$('d-initial').textContent = (driver.name || '?').trim().charAt(0).toUpperCase();
    W.$('d-name').textContent = driver.name || 'Your driver';
    W.$('d-meta').textContent = (driver.rating ? '★ ' + Number(driver.rating).toFixed(1) : '') + (driver.totalRides ? ' · ' + driver.totalRides + ' rides' : '');
    W.$('d-fare').textContent = W.naira(driver.fareNgn || s.offerNgn);
    W.$('d-vehicle').textContent = driver.vehicle || '—';
    W.$('d-plate').textContent = driver.plate || '—';
    W.$('d-eta').textContent = s.trip && s.trip.status === 'ARRIVED' ? 'Here now' : driver.etaMin ? minutes(driver.etaMin) : '—';
    var call = W.$('d-call');
    W.show(call, Boolean(driver.phone));
    if (driver.phone) call.setAttribute('href', 'tel:' + driver.phone);
  }

  /* ── the loop ─────────────────────────────────────────────────────────── */

  function apply(next) {
    var before = state && state.phase;
    state = next;
    if (next.phase !== 'offers') seenOffers = null;

    // Switch the view FIRST: the map measures its box when it is created, and a
    // hidden box measures zero.
    if (before !== next.phase) {
      if (next.phase !== 'offers') closeSheets();
      if (before === 'offers' && next.phase === 'idle') {
        W.$('idle-text').textContent = 'This search has ended. Send your trip to the Wheelers bot to look again — you can name a higher price this time.';
      }
      if (before === 'confirmed' && next.phase === 'idle') {
        W.$('idle-text').textContent = 'This trip has ended. Thanks for riding with Wheelers! Your receipt is in the chat.';
      }
      W.showOnly(next.phase);
    }

    if (next.phase === 'price') drawPrice(next);
    else if (next.phase === 'offers') drawSent(next);
    else if (next.phase === 'confirmed') drawConfirmed(next);
  }

  function refresh() {
    return W.api('GET', '/ride-page/state').then(apply).catch(function (error) {
      if (error.status === 401) { stopped = true; clearTimeout(polling); W.fatal(error.message); }
      // Anything else — a dropped connection, a slow server — just waits for the next tick.
    });
  }

  var stopped = false;
  function loop() {
    if (stopped) return;
    var wait = state && state.phase === 'confirmed' ? TRACK_MS : POLL_MS;
    polling = setTimeout(function () {
      if (document.hidden || busy) return loop();
      refresh().then(loop);
    }, wait);
  }
  refresh().then(loop);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    refresh();
    if (map) setTimeout(function () { map.invalidateSize(); }, 50);   // the map was sized while hidden
  });
})();
