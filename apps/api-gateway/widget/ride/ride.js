/* The Wheelers bidding page. No dependencies, no build step.
 *
 * It holds no booking state of its own: every few seconds it asks the server
 * where the booking is and redraws. That is why leaving, refreshing, or coming
 * back an hour later shows the same list — and the same poll is how the server
 * knows the rider is looking, so offers become toasts here instead of messages
 * in the chat. */
(function () {
  'use strict';
  var W = window.Wheelers;
  var POLL_MS = 3000;

  var state = null;          // the last thing the server told us
  var known = null;          // offers by key, as last drawn — null until the first draw
  var sortBy = 'price';
  var picked = null;         // the offer in the Accept sheet
  var topupFor = null;       // { key } when money is being added to accept an offer, { } otherwise
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
    setText('[data-route="pickup"]', route.pickupAddress);
    setText('[data-route="dest"]', route.destAddress);
    setText('[data-route="distance"]', (Number(route.distanceKm) || 0).toFixed(1) + ' km');
    setText('[data-route="time"]', '~' + minutes(route.durationMin));
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
    ['sheet-offer', 'sheet-accept', 'sheet-topup'].forEach(function (id) { W.show(W.$(id), false); });
    W.show(W.$('overlay'), false);
    topupFor = null;
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

    // The wallet is checked when they ACCEPT a driver. Say so early, and offer
    // the shortcut, rather than letting it be a surprise at the last step.
    var short = Math.ceil(amount - state.balanceNgn);
    var showShort = amount >= floor && short > 0;
    W.show(W.$('price-short'), showShort);
    if (showShort) {
      W.$('price-short-text').textContent = 'Your wallet has ' + W.naira(state.balanceNgn) + '. You can search now — you’ll need ' + W.naira(short) + ' more before you accept a driver.';
      W.$('price-topup').setAttribute('data-amount', String(short));
    }
  }
  W.$('price-input').addEventListener('input', function () { W.formatAmountInput(this); syncPrice(); });

  W.$('price-topup').addEventListener('click', function () {
    openTopup(Number(this.getAttribute('data-amount')), {});
  });

  W.$('find').addEventListener('click', function () {
    var button = this;
    if (busy) return;
    busy = true;
    button.className = 'btn primary busy';
    button.firstChild.textContent = 'Asking drivers… ';
    W.api('POST', '/ride-page/find', { amountNgn: W.parseAmount(W.$('price-input').value) }).then(function (next) {
      known = null;
      apply(next);
      say('Your price is out. Offers will appear here.', 'good');
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

  /* ── 2 · offers ───────────────────────────────────────────────────────── */

  function sorted(offers) {
    return offers.slice().sort(function (a, b) {
      return sortBy === 'eta'
        ? (a.etaMin - b.etaMin) || (a.priceNgn - b.priceNgn)
        : (a.priceNgn - b.priceNgn) || (a.etaMin - b.etaMin);
    });
  }

  function buildOffer(offer) {
    var item = el('li', 'offer');
    item.setAttribute('data-key', offer.key);

    item.appendChild(el('div', 'avatar', (offer.driverName || '?').trim().charAt(0).toUpperCase()));

    var who = el('div', 'who');
    who.appendChild(el('strong', '', offer.driverName));
    who.appendChild(el('span', '', offer.vehicle || 'Vehicle on file'));
    item.appendChild(who);

    var price = el('div', 'price');
    price.appendChild(el('span', 'amount-text', ''));
    price.appendChild(el('small', '', ''));
    item.appendChild(price);

    item.appendChild(el('div', 'tags'));

    var accept = el('button', 'btn primary', 'Accept');
    accept.type = 'button';
    accept.addEventListener('click', function () { openAccept(item.getAttribute('data-key')); });
    item.appendChild(accept);
    return item;
  }

  function fillOffer(item, offer, myOffer, isBest) {
    item.className = 'offer' + (isBest ? ' best' : '') + (item.className.indexOf(' in') >= 0 ? ' in' : '');
    item.querySelector('.amount-text').textContent = W.naira(offer.priceNgn);

    var diff = offer.priceNgn - myOffer;
    var note = item.querySelector('.price small');
    note.className = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
    note.textContent = diff > 0 ? '+' + W.naira(diff) : diff < 0 ? '−' + W.naira(-diff) : 'your price';

    var tags = item.querySelector('.tags');
    tags.innerHTML = '';
    tags.appendChild(el('span', 'tag', minutes(offer.etaMin) + ' away'));
    // The plate is what a rider checks at the kerb: always whole, never cut off.
    if (offer.plate) tags.appendChild(el('span', 'tag plate', offer.plate));
    if (offer.distanceKm !== null && offer.distanceKm !== undefined) tags.appendChild(el('span', 'tag', Number(offer.distanceKm).toFixed(1) + ' km'));
    if (offer.rating) tags.appendChild(el('span', 'tag star', '★ ' + Number(offer.rating).toFixed(1)));
    if (isBest) tags.appendChild(el('span', 'tag', sortBy === 'eta' ? 'Nearest' : 'Cheapest'));
  }

  function drawOffers(s) {
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

    var list = W.$('offers');
    var firstDraw = known === null;
    var next = {};
    s.offers.forEach(function (offer) { next[offer.key] = offer; });

    // What changed since the last look? Said as toasts — never as chat messages.
    if (!firstDraw) {
      s.offers.forEach(function (offer) {
        var before = known[offer.key];
        if (!before) say('New offer · ' + offer.driverName + ' ' + W.naira(offer.priceNgn));
        else if (before.priceNgn !== offer.priceNgn) say(offer.driverName + ' updated to ' + W.naira(offer.priceNgn));
      });
      Object.keys(known).forEach(function (key) {
        if (!next[key]) say(known[key].driverName + ' withdrew');
      });
    }

    // Drop what is gone…
    Array.prototype.slice.call(list.children).forEach(function (item) {
      var key = item.getAttribute('data-key');
      if (next[key] || item.className.indexOf(' out') >= 0) return;
      item.className += ' out';
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 360);
    });

    // …then add, update and order what is here.
    var ordered = sorted(s.offers);
    ordered.forEach(function (offer, index) {
      var item = list.querySelector('[data-key="' + offer.key.replace(/"/g, '\\"') + '"]');
      var isNew = !item;
      if (isNew) {
        item = buildOffer(offer);
        if (!firstDraw) item.className += ' in';
      }
      var changed = !isNew && known && known[offer.key] && known[offer.key].priceNgn !== offer.priceNgn;
      fillOffer(item, offer, s.offerNgn, index === 0 && ordered.length > 1);
      if (changed) item.className += ' changed';
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
    });

    known = next;
    W.$('offers-title').textContent = s.offers.length === 0 ? 'Offers' : s.offers.length + (s.offers.length === 1 ? ' offer' : ' offers');
    W.show(W.$('searching'), s.offers.length === 0);

    // A sheet open on an offer that has just gone must not stay open on nothing.
    if (picked && !next[picked] && !W.$('sheet-accept').hidden) {
      closeSheets();
      say('That offer is no longer on the table.', 'bad');
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (button) {
    button.addEventListener('click', function () {
      sortBy = button.getAttribute('data-sort');
      Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (other) {
        other.className = other === button ? 'on' : '';
      });
      if (state && state.phase === 'offers') drawOffers(state);
    });
  });

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

  /* accept */

  function openAccept(key) {
    if (!state || state.phase !== 'offers') return;
    var offer = null;
    state.offers.forEach(function (candidate) { if (candidate.key === key) offer = candidate; });
    if (!offer) return;
    picked = key;
    W.$('sa-name').textContent = offer.driverName;
    W.$('sa-fare').textContent = W.naira(offer.priceNgn);
    W.$('sa-eta').textContent = minutes(offer.etaMin);
    W.$('sa-vehicle').textContent = [offer.vehicle, offer.plate].filter(Boolean).join(' · ') || '—';
    var after = state.balanceNgn - offer.priceNgn;
    W.$('sa-after').textContent = after >= 0 ? W.naira(after) : 'Add ' + W.naira(Math.ceil(-after)) + ' first';
    W.$('accept-go').textContent = after >= 0 ? 'Accept & hold fare' : 'Add money & accept';
    W.show(W.$('accept-err'), false);
    openSheet('sheet-accept');
  }

  function accept(key) {
    if (busy) return;
    busy = true;
    var button = W.$('accept-go');
    button.className = 'btn primary busy';
    W.api('POST', '/ride-page/accept', { key: key }).then(function (next) {
      closeSheets();
      apply(next);
      say('Ride confirmed!', 'good');
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      if (error.code === 'WALLET_SHORT') return showTopup(error.body, { key: key });
      // A driver who has gone, or been taken, is not coming back: refresh the list.
      if (error.status === 409) { closeSheets(); say(error.message, 'bad'); return refresh(); }
      W.$('accept-err').textContent = error.message;
      W.show(W.$('accept-err'), true);
    }).then(function () { busy = false; button.className = 'btn primary'; });
  }
  W.$('accept-go').addEventListener('click', function () { if (picked) accept(picked); });

  /* add money — one figure to send, never an itemised list */

  function showTopup(quote, purpose) {
    if (!quote.account) {
      closeSheets();
      return say('Your account number is still being prepared. Try again in a minute.', 'bad');
    }
    W.$('tu-send').textContent = W.naira(quote.sendNgn);
    W.$('tu-gets').textContent = W.naira(quote.shortNgn || quote.walletGetsNgn);
    W.$('tu-bank').textContent = quote.account.bankName;
    W.$('tu-number').textContent = quote.account.accountNumber;
    W.$('tu-name').textContent = quote.account.accountName;
    W.$('tu-wait').textContent = purpose.key
      ? 'The moment it lands, your driver is confirmed — no need to tap again.'
      : 'Your balance updates here the moment it lands.';
    openSheet('sheet-topup');
    topupFor = { key: purpose.key || null, needs: (quote.balanceNgn || 0) + (quote.shortNgn || quote.walletGetsNgn) };
  }

  function openTopup(amount, purpose) {
    W.api('GET', '/ride-page/topup?amount=' + encodeURIComponent(amount)).then(function (quote) {
      showTopup(quote, purpose);
    }).catch(function (error) {
      if (error.status === 401) return W.fatal(error.message);
      say(error.message, 'bad');
    });
  }

  W.$('tu-copy').addEventListener('click', function () {
    var button = this;
    W.copy(W.$('tu-number').textContent).then(function (ok) {
      if (!ok) return say('Press and hold the number to copy');
      button.textContent = 'Copied ✓';
      setTimeout(function () { button.textContent = 'Copy account number'; }, 2000);
    });
  });

  /** Called on every poll: has the transfer landed? */
  function checkTopup(balance) {
    if (!topupFor || W.$('sheet-topup').hidden) return;
    if (balance + 0.004 < topupFor.needs) return;
    var key = topupFor.key;
    closeSheets();
    say('Money received — ' + W.naira(balance) + ' in your wallet.', 'good');
    if (key) accept(key);          // they already chose this driver; finish the job
  }

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

  /* ── 3 · confirmed ────────────────────────────────────────────────────── */

  function drawConfirmed(s) {
    var driver = s.driver || {};
    W.$('d-initial').textContent = (driver.name || '?').trim().charAt(0).toUpperCase();
    W.$('d-name').textContent = driver.name || 'Your driver';
    W.$('d-meta').textContent = (driver.rating ? '★ ' + Number(driver.rating).toFixed(1) : '') + (driver.totalRides ? ' · ' + driver.totalRides + ' rides' : '');
    W.$('d-fare').textContent = W.naira(driver.fareNgn || s.offerNgn);
    W.$('d-vehicle').textContent = driver.vehicle || '—';
    W.$('d-plate').textContent = driver.plate || '—';
    W.$('d-eta').textContent = driver.etaMin ? minutes(driver.etaMin) : '—';
    var call = W.$('d-call');
    W.show(call, Boolean(driver.phone));
    if (driver.phone) call.setAttribute('href', 'tel:' + driver.phone);
  }

  /* ── the loop ─────────────────────────────────────────────────────────── */

  function apply(next) {
    var before = state && state.phase;
    state = next;
    W.$('balance').textContent = W.naira(next.balanceNgn);
    checkTopup(next.balanceNgn);

    if (next.phase === 'price') drawPrice(next);
    else if (next.phase === 'offers') drawOffers(next);
    else if (next.phase === 'confirmed') drawConfirmed(next);

    if (next.phase !== 'offers') known = null;
    if (before !== next.phase) {
      if (next.phase !== 'offers' && next.phase !== 'price') closeSheets();
      if (before === 'offers' && next.phase === 'idle') {
        W.$('idle-text').textContent = 'This search has ended. Send your trip to the Wheelers bot to look again — you can name a higher price this time.';
      }
      W.showOnly(next.phase);
    }
  }

  function refresh() {
    return W.api('GET', '/ride-page/state').then(apply).catch(function (error) {
      if (error.status === 401) { clearInterval(polling); W.fatal(error.message); }
      // Anything else — a dropped connection, a slow server — just waits for the next tick.
    });
  }

  refresh().then(function () {
    polling = setInterval(function () { if (!document.hidden && !busy) refresh(); }, POLL_MS);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });

  W.$('balance-pill').addEventListener('click', function () {
    if (state) say('Wallet balance: ' + W.naira(state.balanceNgn));
  });
})();
