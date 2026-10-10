/* The Wheelers ride page. No dependencies, no build step.
 *
 * Name a price, then see every driver's offer as it comes: accept one (paying
 * right here when the wallet is short — the driver is confirmed the moment
 * the money lands), decline them all, change the price or cancel. Once a
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
  var seenOffers = null;     // how many offers there were at the last look — null until the first
  var paying = null;         // the offer being paid for: { key, driverName } — its card stays green
  var declined = null;       // { offers, until }: the offers just declined, shown red for a moment
  var declinedOnce = false;  // this search had its offers declined: say the search goes on
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
      var destRow = dest.closest('.stop');
      if (!destRow) return;
      stops.forEach(function (address, index) {
        var row = el('div', 'stop mid');
        row.appendChild(el('span', 'dot mid'));
        var place = el('div', 'place');
        place.appendChild(el('span', 'label', stops.length > 1 ? 'Stop ' + (index + 1) : 'Stop'));
        place.appendChild(el('span', 'where', address));
        row.appendChild(place);
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
    W.show(W.$('sheet-paywith'), false);
    W.show(W.$('sheet-offer'), false);
    W.show(W.$('sheet-pay'), false);
    W.show(W.$('sheet-confirm'), false);
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
  W.$('overlay').addEventListener('click', function () { closeSheets(); paying = null; if (state && state.phase === 'offers') drawSent(state); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (button) {
    button.addEventListener('click', function () { closeSheets(); paying = null; if (state && state.phase === 'offers') drawSent(state); });
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
      // One fare for the rider: nothing about what it is made of.
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
      say('Your price is out. Offers will show up here.', 'good');
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

  /* ── 2 · the price is out — drivers' offers, live ─────────────────────── */

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

    var offers = s.offers || [];
    var showingDeclined = declined && Date.now() < declined.until;
    if (!showingDeclined) declined = null;
    var list = showingDeclined ? declined.offers : offers;

    var count = offers.length;
    W.show(W.$('searching'), list.length === 0);
    W.$('sent-title').textContent = 'Asking drivers near you…';
    W.$('sent-text').textContent = declinedOnce
      ? 'Offers declined. New offers will show up here — raising your price usually gets drivers moving.'
      : 'Offers show up here as drivers answer.';
    if (seenOffers !== null && count > seenOffers && !paying) say(count - seenOffers === 1 ? 'New offer' : (count - seenOffers) + ' new offers', 'good');
    seenOffers = count;

    drawOffers(list, showingDeclined, s.offerNgn);
    W.$('offers-title').textContent = showingDeclined
      ? 'Offers declined'
      : count === 0 ? 'Driver offers' : count === 1 ? '1 driver offered' : count + ' drivers offered';
    W.$('offers-lede').textContent = count > 0 && !showingDeclined
      ? 'Pick one. New offers show up here as drivers answer.'
      : 'Drivers near you can see your price. Offers show up here.';
    W.show(W.$('decline-all'), count > 0 && !paying && !showingDeclined);

    var back = W.$('back-to-chat');
    W.show(back, Boolean(s.chatUrl));
    if (s.chatUrl) back.setAttribute('href', s.chatUrl);
  }

  /** How a driver's price sits next to the rider's: "Took your price", "₦200 more", "₦300 less". */
  function versusYours(priceNgn, yoursNgn) {
    var gap = Math.round(Number(priceNgn) - Number(yoursNgn));
    if (!yoursNgn || gap === 0) return { text: 'Took your price', tone: 'same' };
    return gap > 0
      ? { text: W.naira(gap) + ' more', tone: 'up' }
      : { text: W.naira(-gap) + ' less', tone: 'down' };
  }

  /** One card per offer: white while open, green while paying, red once declined. */
  // The page asks the server every few seconds. Redrawing identical cards made
  // them flash (and replay their slide-in) each time: draw only when something
  // changed, and slide in only the offers not seen before.
  var drawnOffers = null;
  var shownKeys = {};

  function drawOffers(offers, asDeclined, yoursNgn) {
    var holder = W.$('offer-list');
    var signature = JSON.stringify([offers, asDeclined, yoursNgn, paying && paying.key, busy]);
    if (signature === drawnOffers) return;
    drawnOffers = signature;
    holder.innerHTML = '';
    offers.forEach(function (offer) {
      var isPaying = paying && paying.key === offer.key;
      var isNew = !shownKeys[offer.key];
      shownKeys[offer.key] = true;
      var card = el('div', 'offer' + (isNew ? ' in' : '') + (asDeclined ? ' declined' : isPaying ? ' paying' : paying ? ' muted' : ''));
      var top = el('div', 'offer-top');
      var name = offer.driverName || 'Driver';
      top.appendChild(el('div', 'avatar', name.trim().charAt(0).toUpperCase()));
      var who = el('div', 'who');
      who.appendChild(el('strong', '', name));
      who.appendChild(el('span', '', [
        offer.rating ? '★ ' + Number(offer.rating).toFixed(1) : '',
        offer.vehicle || ''
      ].filter(Boolean).join(' · ')));
      top.appendChild(who);
      var price = el('div', 'price', W.naira(offer.priceNgn));
      var versus = versusYours(offer.priceNgn, yoursNgn);
      price.appendChild(el('small', versus.tone, versus.text));
      top.appendChild(price);
      card.appendChild(top);

      var facts = el('div', 'offer-facts');
      facts.appendChild(el('span', 'pill', minutes(offer.etaMin) + ' away'));
      if (offer.distanceKm) facts.appendChild(el('span', 'pill', Number(offer.distanceKm).toFixed(1) + ' km to you'));
      if (offer.plate) facts.appendChild(el('span', 'pill plate', offer.plate));
      card.appendChild(facts);

      if (asDeclined) {
        card.appendChild(el('div', 'offer-status', 'Declined'));
      } else if (isPaying) {
        var status = el('div', 'offer-status');
        status.appendChild(el('span', 'spinner'));
        status.appendChild(document.createTextNode('Making payment…'));
        card.appendChild(status);
      } else {
        var accept = el('button', 'btn primary', 'Accept ' + W.naira(offer.priceNgn));
        accept.type = 'button';
        accept.disabled = Boolean(paying) || busy;
        accept.addEventListener('click', function () { acceptOffer(offer); });
        card.appendChild(accept);
      }
      holder.appendChild(card);
    });
  }

  /**
   * Accept: with a Stellar wallet and a price for XLM, first ask how to pay —
   * the naira wallet or XLM. Without one, it is naira, straight away.
   */
  function acceptOffer(offer) {
    if (busy || paying) return;
    if (state && state.xlm) return openPayWith(offer, state.xlm);
    payFor(offer, 'ngn');
  }

  /** XLM for a naira price at the page's rate — what the rider is shown (the server sizes the real payment). */
  function xlmFor(priceNgn, xlm) { return priceNgn / xlm.ngnPerXlm; }
  function xlmText(amount) { return (Math.ceil(amount * 100) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' XLM'; }

  var payWith = null;   // { offer, method }

  function openPayWith(offer, xlm) {
    var first = (offer.driverName || 'your driver').split(' ')[0];
    var amountXlm = xlmFor(offer.priceNgn, xlm);
    var xlmCovers = amountXlm <= xlm.spendableXlm;
    var ngnCovers = state.balanceNgn + 0.004 >= offer.priceNgn;
    W.$('pw-sub').textContent = 'Riding with ' + first + ' · fare ' + W.naira(offer.priceNgn);
    W.$('pw-ngn-balance').textContent = 'Balance ' + W.naira(state.balanceNgn) + (ngnCovers ? '' : ' · you can add money next');
    W.$('pw-ngn-amount').textContent = W.naira(offer.priceNgn);
    W.$('pw-xlm-balance').textContent = xlmCovers
      ? 'Balance ' + xlmText(xlm.balanceXlm)
      : 'Not enough: you can spend ' + xlmText(xlm.spendableXlm);
    W.$('pw-xlm-amount').textContent = xlmText(amountXlm);
    W.$('pw-xlm').disabled = !xlmCovers;
    W.$('pw-rate').textContent = '1 XLM ≈ ' + W.naira(xlm.ngnPerXlm) + ' · the price is refreshed every 30 minutes. The driver is paid the same either way.';
    payWith = { offer: offer, method: 'ngn', amountXlm: amountXlm };
    pickMethod('ngn');
    openSheet('sheet-paywith');
  }

  function pickMethod(method) {
    if (!payWith) return;
    payWith.method = method;
    var xlm = method === 'xlm';
    W.$('pw-ngn').className = 'pay-option' + (xlm ? '' : ' on');
    W.$('pw-xlm').className = 'pay-option' + (xlm ? ' on' : '');
    W.$('pw-ngn').setAttribute('aria-checked', String(!xlm));
    W.$('pw-xlm').setAttribute('aria-checked', String(xlm));
    W.$('pw-pay').textContent = xlm ? 'Pay ' + xlmText(payWith.amountXlm) : 'Pay ' + W.naira(payWith.offer.priceNgn);
  }
  W.$('pw-ngn').addEventListener('click', function () { pickMethod('ngn'); });
  W.$('pw-xlm').addEventListener('click', function () { if (!this.disabled) pickMethod('xlm'); });
  W.$('pw-pay').addEventListener('click', function () {
    if (!payWith) return;
    var chosen = payWith;
    payWith = null;
    closeSheets();
    payFor(chosen.offer, chosen.method);
  });

  /* accept: "Making payment…" — then confirmed, or pay right here */

  function payFor(offer, method) {
    if (busy || paying) return;
    busy = true;
    paying = { key: offer.key, driverName: offer.driverName || 'your driver' };
    if (state) drawSent(state);
    W.api('POST', '/ride-page/accept', { key: offer.key, method: method }).then(function (next) {
      paying = null;
      apply(next);
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      if (error.code === 'WALLET_SHORT') return openPay(offer, error.body);
      paying = null;
      say(error.message, 'bad');
      if (state) drawSent(state);
    }).then(function () { busy = false; });
  }

  function openPay(offer, info) {
    var first = (offer.driverName || 'your driver').split(' ')[0];
    W.$('pay-title').textContent = 'Add money to ride with ' + first;
    W.$('pay-sub').textContent = 'Fare ' + W.naira(info.fareNgn) + ' · your wallet ' + W.naira(info.balanceNgn);
    W.$('pay-amount').textContent = W.naira(info.sendNgn);
    var account = info.account;
    W.show(W.$('pay-wait-account'), !account);
    W.$('pay-bank').textContent = account ? account.bankName : '—';
    W.$('pay-number').textContent = account ? account.accountNumber : '—';
    W.$('pay-name').textContent = account ? account.accountName : '—';
    W.$('pay-copy').onclick = function () {
      if (!account) return;
      W.copy(account.accountNumber).then(function () { W.$('pay-copy').textContent = 'Copied'; setTimeout(function () { W.$('pay-copy').textContent = 'Copy'; }, 1800); });
    };
    W.$('pay-note').textContent = first + ' is booked the moment it lands. You don’t need to tap anything again.';
    openSheet('sheet-pay');
  }

  /* decline all: every card turns red, then the list clears — the search goes on */

  W.$('decline-all').addEventListener('click', function () {
    if (busy || !state || state.phase !== 'offers') return;
    var count = (state.offers || []).length;
    ask({
      title: count === 1 ? 'Decline this offer?' : 'Decline all ' + count + ' offers?',
      text: 'We keep looking for a driver. New offers still come in here, and these drivers can send you a new price too.',
      yes: count === 1 ? 'Decline offer' : 'Decline all',
      no: 'Keep offers'
    }).then(function (yes) { if (yes) declineAll(); });
  });

  function declineAll() {
    if (busy || !state || state.phase !== 'offers') return;
    busy = true;
    var shownOffers = (state.offers || []).slice();
    W.api('POST', '/ride-page/decline-all').then(function (next) {
      declined = { offers: shownOffers, until: Date.now() + 1800 };
      declinedOnce = true;
      apply(next);
      setTimeout(function () { if (state) drawSent(state); }, 1900);
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      say(error.message, 'bad');
    }).then(function () { busy = false; });
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
    if (busy) return;
    ask({
      title: 'Stop looking for a driver?',
      text: 'Nothing has been charged. You can book again from the chat any time.',
      yes: 'Cancel search',
      no: 'Keep looking'
    }).then(function (yes) { if (yes) cancelSearch(); });
  });

  function cancelSearch() {
    if (busy) return;
    busy = true;
    W.api('POST', '/ride-page/cancel').then(function (next) {
      apply(next);
      W.$('idle-title').textContent = 'Search cancelled';
      W.$('idle-text').textContent = 'Nothing was charged. Message Wheelers whenever you need a ride.';
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      say(error.message, 'bad');
    }).then(function () { busy = false; });
  }

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
      // OpenStreetMap blocks tiles asked for with no Referer ("Access blocked"
      // on every tile). The page itself sends none (it handles money), so the
      // tiles alone send the site's origin: no path, and the link token is in
      // the #fragment, which is never sent.
      L.tileLayer(trip.map.tileUrl, { attribution: trip.map.attribution, maxZoom: 19, referrerPolicy: 'origin' }).addTo(map);
      L.marker([trip.pickup.lat, trip.pickup.lng], { icon: smallPin('pin-pickup'), keyboard: false }).addTo(map).bindTooltip('Pickup');
      L.marker([trip.destination.lat, trip.destination.lng], { icon: smallPin('pin-dest'), keyboard: false }).addTo(map).bindTooltip('Destination');
      // Once they move the map themselves, stop dragging it back to the car.
      map.on('dragstart', function () { followCar = false; });
    }
    // The planned road, once: pickup to destination through the stops.
    if (!routeLine && trip.line && trip.line.length > 1) {
      routeLine = L.polyline(trip.line.map(function (p) { return [p.lat, p.lng]; }), { color: '#FF7700', weight: 5, opacity: 0.9 }).addTo(map);
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
    W.$('d-foot').textContent = s.paidWithXlm
      ? 'Paying ' + Number(s.paidWithXlm.amountXlm).toLocaleString('en-NG', { maximumFractionDigits: 2 }) + ' XLM from your Stellar wallet (testnet). It goes to your driver when the trip ends.'
      : 'The fare is held in your wallet and paid when the trip ends.';
    var call = W.$('d-call');
    W.show(call, Boolean(driver.phone));
    if (driver.phone) call.setAttribute('href', 'tel:' + driver.phone);
    var chat = W.$('d-chat');
    W.show(chat, Boolean(s.tripChatUrl));
    if (s.tripChatUrl) chat.setAttribute('href', s.tripChatUrl);
    // Before the trip: the code to give the driver. Then: when they arrive.
    W.show(W.$('d-code-box'), Boolean(s.tripCode));
    W.show(W.$('d-eta-box'), !s.tripCode);
    W.$('d-code').textContent = s.tripCode || '';
  }

  /* ── the loop ─────────────────────────────────────────────────────────── */

  /** The badge in the header: where the booking is, at a glance. */
  function drawPill(next) {
    var pill = W.$('top-pill');
    var text = next.phase === 'price' ? 'Step 1 of 2'
      : next.phase === 'offers' ? 'Live'
      : '';
    pill.textContent = text;
    pill.className = 'top-pill' + (next.phase === 'offers' ? ' live' : '');
    W.show(pill, Boolean(text));
  }

  function apply(next) {
    var before = state && state.phase;
    drawPill(next);
    state = next;
    if (next.phase !== 'offers') { seenOffers = null; paying = null; declined = null; declinedOnce = false; }

    // Switch the view FIRST: the map measures its box when it is created, and a
    // hidden box measures zero.
    if (before !== next.phase) {
      if (next.phase !== 'offers') closeSheets();
      if (before === 'offers' && next.phase === 'idle') {
        W.$('idle-title').textContent = 'Search ended';
        W.$('idle-text').textContent = 'This search has ended. Send your trip to the Wheelers bot to look again — you can name a higher price this time.';
      }
      if (before === 'confirmed' && next.phase === 'idle') {
        W.$('idle-title').textContent = 'Trip ended';
        W.$('idle-text').textContent = 'Thanks for riding with Wheelers! Your receipt is in the chat.';
      }
      W.showOnly(next.phase);
    }

    if (next.phase === 'idle') {
      var idleBack = W.$('idle-back');
      W.show(idleBack, Boolean(next.chatUrl));
      if (next.chatUrl) idleBack.setAttribute('href', next.chatUrl);
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
