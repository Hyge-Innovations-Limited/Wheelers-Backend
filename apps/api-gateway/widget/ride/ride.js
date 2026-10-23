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
  /** "Timilehin Olowu" → "TO", as the app's avatar shows a name. */
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('');
  }
  function minutes(n) { return n + ' min'; }

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

  function secondsHere() { return Math.round((Date.now() - openedAt) / 1000); }

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
    if (!W.$('sheet-pay').hidden || !W.$('sheet-paywith').hidden) track('pay_sheet_closed');
    if (!W.$('sheet-cancel').hidden) track('cancel_kept');
  }
  W.$('overlay').addEventListener('click', function () { noteSheetLeft(); closeSheets(); paying = null; if (state && state.phase === 'offers') drawSent(state); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (button) {
    button.addEventListener('click', function () { noteSheetLeft(); closeSheets(); paying = null; if (state && state.phase === 'offers') drawSent(state); });
  });

  /* ── 1 · name your price ──────────────────────────────────────────────── */

  var priceDrawnFor = null;

  function drawPrice(s) {
    drawRoute(s.route);
    W.show(W.$('route-edit'), Boolean(s.canEditTrip));
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
    var hint = W.$('price-hint');
    W.show(W.$('price-err'), false);

    // The app's words under the price (components/rider/price-card.tsx).
    if (amount > 0 && amount < floor) {
      hint.className = 'price-note bad';
      hint.textContent = 'The lowest price for this trip is ' + W.naira(floor) + '.';
    } else {
      hint.className = 'price-note';
      hint.textContent = amount <= floor ? 'This is the minimum offer for this trip.' : 'Minimum offer: ' + W.naira(floor);
    }
    W.$('price-down').disabled = !(amount > floor);
    var find = W.$('find');
    find.disabled = !(amount >= floor);
    if (!busy) find.textContent = amount > 0 ? 'Find drivers at ' + W.naira(amount) : 'Find drivers';
  }

  // Minus and plus move the price to the next ₦100, as in the app; never under the lowest.
  function stepPrice(up) {
    if (!state || state.phase !== 'price') return;
    var amount = W.parseAmount(W.$('price-input').value) || state.route.suggestedFareNgn;
    var next = up ? amount + (100 - (amount % 100)) : Math.max(state.minOfferNgn, amount - (amount % 100 || 100));
    W.$('price-input').value = Number(next).toLocaleString('en-NG');
    syncPrice();
    track('price_changed', { method: up ? 'plus' : 'minus', amountNgn: next });
  }
  W.$('price-down').addEventListener('click', function () { stepPrice(false); });
  W.$('price-up').addEventListener('click', function () { stepPrice(true); });
  var typedTimer = null;
  W.$('price-input').addEventListener('input', function () {
    W.formatAmountInput(this);
    syncPrice();
    // A price typed is one step once they stop typing, not one per key.
    clearTimeout(typedTimer);
    typedTimer = setTimeout(function () { track('price_changed', { method: 'typed', amountNgn: W.parseAmount(W.$('price-input').value) }); }, 1200);
  });

  W.$('find').addEventListener('click', function () {
    var button = this;
    if (busy) return;
    busy = true;
    button.className = 'btn primary busy';
    button.textContent = 'Asking drivers…';
    track('find_tapped', { amountNgn: W.parseAmount(W.$('price-input').value), suggestedNgn: state && state.route ? state.route.suggestedFareNgn : 0, minNgn: state ? state.minOfferNgn : 0 });
    W.api('POST', '/ride-page/find', { amountNgn: W.parseAmount(W.$('price-input').value) }).then(function (next) {
      seenOffers = null;
      apply(next);
      say('Your price is out. Offers will show up here.', 'good');
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
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

  function drawSent(s) {
    drawRoute(s.route);

    // "Ilemere Rd → Ikorodu Garage · your offer ₦12,450", as in the app.
    var place = function (address) { return String(address || '').split(',')[0].trim(); };
    W.$('offers-route').textContent = [place(s.route && s.route.pickupAddress), place(s.route && s.route.destAddress)].filter(Boolean).join(' → ');
    W.$('my-offer').textContent = W.naira(s.offerNgn);

    // Declined one by one on this page, as in the app: off the list here, the search goes on.
    var offers = (s.offers || []).filter(function (offer) { return !dismissed[offer.key]; });
    var showingDeclined = declined && Date.now() < declined.until;
    if (!showingDeclined) declined = null;
    var list = showingDeclined ? declined.offers : offers;

    var count = offers.length;
    W.show(W.$('searching'), list.length === 0);
    W.$('sent-text').textContent = declinedOnce
      ? 'Offers declined. A higher price usually gets drivers moving.'
      : 'Your offer has been sent to drivers near you.';
    W.$('finding-route').textContent = W.$('offers-route').textContent;
    W.$('finding-offer').textContent = W.naira(s.offerNgn);
    W.show(W.$('offers-sub'), list.length > 0);
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
      top.appendChild(el('div', 'price', W.naira(offer.priceNgn)));
      card.appendChild(top);
      if (offer.plate || offer.distanceKm) {
        var meta = el('div', 'offer-meta');
        meta.appendChild(el('span', 'offer-distance', offer.distanceKm ? Number(offer.distanceKm).toFixed(1) + ' km to you' : ''));
        if (offer.plate) meta.appendChild(el('span', 'plate', offer.plate));
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
        decline.disabled = Boolean(paying) || busy;
        decline.addEventListener('click', function () {
          track('offer_declined', { priceNgn: offer.priceNgn, rank: index + 1 });
          dismissed[offer.key] = true;
          drawnOffers = null;
          if (state && state.phase === 'offers') drawSent(state);
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

  /**
   * Accept: with a Stellar wallet and a price for XLM, first ask how to pay —
   * the naira wallet or XLM. Without one, it is naira, straight away.
   */
  function acceptOffer(offer) {
    if (busy || paying) return;
    var list = (state && state.offers) || [];
    var rank = list.map(function (o) { return o.key; }).indexOf(offer.key) + 1;
    track('accept_tapped', { priceNgn: offer.priceNgn, rank: rank, offers: list.length });
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
    track('pay_method_chosen', { method: chosen.method });
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
      if (error.code === 'WALLET_SHORT') {
        track('wallet_short_shown', { shortNgn: error.body && error.body.shortNgn ? error.body.shortNgn : 0 });
        return openPay(offer, error.body);
      }
      track('accept_failed', { code: error.code || String(error.status) });
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
      track('account_copied');
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
      track('decline_all', { count: shownOffers.length });
      declinedOnce = true;
      apply(next);
      setTimeout(function () { if (state) drawSent(state); }, 1900);
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      say(error.message, 'bad');
    }).then(function () { busy = false; });
  }

  /* change the bid */

  /** The change-price sheet, starting at the current offer plus `raiseBy` (as the app's + ₦200 / + ₦500 / Other). */
  function openChangePrice(raiseBy) {
    if (!state || state.phase !== 'offers') return;
    W.$('offer-input').value = Number(state.offerNgn + (raiseBy || 0)).toLocaleString('en-NG');
    W.$('offer-current').textContent = 'Current ' + W.naira(state.offerNgn);
    W.show(W.$('offer-err'), false);
    drawChips('offer-chips', 'offer-input', state.route.suggestedFareNgn, state.minOfferNgn, syncOfferSheet);
    syncOfferSheet();
    openSheet('sheet-offer');
  }
  /** The chips and the button follow the figure: "Update price to ₦X". */
  function syncOfferSheet() {
    var amount = W.parseAmount(W.$('offer-input').value);
    markChips('offer-chips', amount);
    W.$('offer-save').textContent = amount > 0 && state && amount !== state.offerNgn ? 'Update price to ' + W.naira(amount) : 'Update price';
  }
  W.$('change-offer').addEventListener('click', function () { track('price_sheet_opened', { from: 'change_my_price' }); openChangePrice(0); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-raise]'), function (button) {
    button.addEventListener('click', function () {
      var by = Number(button.getAttribute('data-raise')) || 0;
      track('raise_tapped', { by: by });
      openChangePrice(by);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-add]'), function (button) {
    button.addEventListener('click', function () {
      var amount = W.parseAmount(W.$('offer-input').value) || (state ? state.offerNgn : 0);
      W.$('offer-input').value = Number(amount + Number(button.getAttribute('data-add'))).toLocaleString('en-NG');
      syncOfferSheet();
    });
  });
  W.$('offer-reset').addEventListener('click', function () {
    if (!state) return;
    W.$('offer-input').value = Number(Math.max(state.minOfferNgn || 0, state.offerNgn)).toLocaleString('en-NG');
    syncOfferSheet();
  });
  W.$('offer-input').addEventListener('input', function () {
    W.formatAmountInput(this);
    syncOfferSheet();
  });

  W.$('offer-save').addEventListener('click', function () {
    var button = this;
    var amount = W.parseAmount(W.$('offer-input').value);
    if (busy) return;
    if (state && amount === state.offerNgn) return closeSheets();
    busy = true;
    button.className = 'btn primary busy';
    var before = state ? state.offerNgn : 0;
    W.api('POST', '/ride-page/offer', { amountNgn: amount }).then(function (next) {
      closeSheets();
      apply(next);
      track('price_updated', { fromNgn: before, toNgn: amount });
      say('Offer updated to ' + W.naira(amount) + '. Drivers notified.', 'good');
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
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
        W.show(W.$('cancel-other'), reason === OTHER);
        if (reason === OTHER) setTimeout(function () { W.$('cancel-other').focus(); }, 30);
        syncCancel();
      });
      holder.appendChild(row);
    });
  }
  function syncCancel() {
    var words = W.$('cancel-other').value.trim();
    W.$('cancel-yes').disabled = !cancelReason || (cancelReason === OTHER && words.length < 3);
    W.show(W.$('cancel-err'), false);
  }
  W.$('cancel-other').addEventListener('input', syncCancel);

  W.$('cancel-search').addEventListener('click', function () {
    if (busy) return;
    cancelReason = null;
    W.$('cancel-other').value = '';
    W.show(W.$('cancel-other'), false);
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
    if (cancelReason === OTHER) body.detail = W.$('cancel-other').value.trim();
    W.api('POST', '/ride-page/cancel', body).then(function (next) {
      track('cancel_confirmed', body);
      closeSheets();
      apply(next);
      W.$('idle-title').textContent = 'Search cancelled';
      W.$('idle-text').textContent = 'Nothing was charged. Message Wheelers whenever you need a ride.';
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
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
      W.api('POST', '/ride-page/edit-trip').then(function (next) {
        apply(next);
        if (next.phase === 'price') say('Search stopped. Change your trip or your price, then find drivers again.', 'good');
      }).catch(function (error) {
        if (error.status === 401) return W.fatal(error.message);
        say(error.message, 'bad');
      }).then(function () { busy = false; });
    });
  });

  /* change the trip: type a place, pick it from the list (the chat's own lookup) */

  var trip = null;          // { pickup, destination, stops: [] } — each { lat, lng, address }, null while being typed
  var searchTimer = null;
  var searchFor = null;     // the field whose list is showing
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
    searchFor = null;
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
    searchFor = field;
    var holder = W.$('place-list');
    holder.innerHTML = '';
    var looking = el('div', 'place-status');
    looking.appendChild(el('span', 'spinner'));
    looking.appendChild(document.createTextNode('Looking for places…'));
    holder.appendChild(looking);
    W.api('GET', '/ride-page/places?field=' + encodeURIComponent(field) + '&q=' + encodeURIComponent(query)).then(function (answer) {
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
          W.$(field === 'pickup' ? 'trip-pickup' : 'trip-dest').value = place.address;
          clearPlaces();
          syncTrip();
        });
        holder.appendChild(option);
      });
    }).catch(function (error) {
      if (seq !== searchSeq) return;
      if (error.status === 401) return W.fatal(error.message);
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
    W.api('POST', '/ride-page/route', { pickup: trip.pickup, destination: trip.destination, stops: trip.stops }).then(function (next) {
      closeSheets();
      apply(next);
      track('trip_saved', { distanceKm: next.route ? next.route.distanceKm : 0, suggestedNgn: next.route ? next.route.suggestedFareNgn : 0, stops: trip.stops.length });
      say('Trip changed. The suggested price is ' + W.naira(next.route ? next.route.suggestedFareNgn : 0) + '.', 'good');
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      track('trip_save_failed', { code: error.code || String(error.status) });
      W.$('trip-err').textContent = error.message;
      W.show(W.$('trip-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; button.textContent = 'Save trip'; });
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
    W.$('trip-title').textContent = copy[1] + copy[2];

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

  W.$('d-call').addEventListener('click', function () { track('call_driver_tapped'); });
  W.$('d-chat').addEventListener('click', function () { track('chat_driver_tapped'); });
  W.$('back-to-chat').addEventListener('click', function () { track('chat_link_tapped', { from: 'offers' }); });
  W.$('idle-back').addEventListener('click', function () { track('chat_link_tapped', { from: 'ended' }); });
  W.$('map-recentre').addEventListener('click', function () {
    track('map_recentred');
    followCar = true;
    if (map && carMarker) map.setView(carMarker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
  });

  function drawConfirmed(s) {
    if (s.route) drawRoute(s.route);
    if (s.trip) drawTrip(s.trip);
    var driver = s.driver || {};
    // As the app's trip screen: "Tunde · 4.9", the car under it, the plate on the right.
    var name = (driver.name || 'Your driver').trim();
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

  /** The badge in the header: where the booking is, at a glance. */
  function drawPill(next) {
    var pill = W.$('top-pill');
    // The app shows where you are with its step bar, not a badge up here.
    var text = '';
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
      track('phase_shown', { from: before || 'none' });
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
    // Back from a search to change the trip: the box holds the price they had out (raised or not).
    if (before === 'offers' && next.phase === 'price' && next.lastOfferNgn) W.$('price-input').value = Number(next.lastOfferNgn).toLocaleString('en-NG');
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
  track('page_opened');
  refresh().then(loop);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      track('page_hidden', { secondsOnPage: secondsHere() });
      sendSteps(true);
      return;
    }
    track('page_visible', { secondsOnPage: secondsHere() });
    refresh();
    if (map) setTimeout(function () { map.invalidateSize(); }, 50);   // the map was sized while hidden
  });
  // Closing the tab, or WhatsApp closing its browser: the last steps go with keepalive.
  window.addEventListener('pagehide', function () {
    track('page_left', { secondsOnPage: secondsHere() });
    sendSteps(true);
  });
})();
