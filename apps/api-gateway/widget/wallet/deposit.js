(function () {
  'use strict';
  var W = window.Wheelers;
  var startingBalance = 0;
  var watching = false;
  var ride = null;           // { driverName, fareNgn, landsNgn, sendNgn } when this deposit is to take a driver

  if (!W.takeToken()) {
    W.fatal('This link is not valid.');
    return;
  }

  W.api('GET', '/wallet-page/session').then(function (s) {
    if (s.scope !== 'deposit') return W.fatal('This link is for something else.');
    if (s.needsPhone) return W.showOnly('needs-phone');
    if (!s.account) return W.fatal('Your account number is still being prepared. Try again in a minute.');
    // Held money counts: a ride top-up is locked for the fare within a second of
    // landing, so the spendable balance alone can look as if nothing arrived.
    startingBalance = s.balanceNgn + (s.lockedNgn || 0);
    W.$('balance').textContent = W.naira(s.balanceNgn);
    W.$('acct-bank').textContent = s.account.bankName;
    W.$('acct-number').textContent = s.account.accountNumber;
    W.$('acct-name').textContent = s.account.accountName;

    // Sent here from the chat to take a driver: they already know what they are
    // paying for, so skip "how much?" and open on the figure to send.
    if (s.rideTopup) {
      ride = s.rideTopup;
      var driver = String(ride.driverName || 'your driver').split(' ')[0];
      W.$('amount').value = Number(ride.landsNgn).toLocaleString('en-NG');
      W.$('pay-eyebrow').textContent = 'Pay for your ride';
      W.$('pay-amount').textContent = W.naira(ride.sendNgn);
      W.$('pay-lede').textContent = 'To ride with ' + driver + ' at ' + W.naira(ride.fareNgn) + '. From any bank app, to your own Wheelers account below.';
      W.$('row-gets').textContent = W.naira(ride.landsNgn);
      W.$('waiting-text').textContent = 'Waiting for your transfer — ' + driver + ' is confirmed the moment it lands';
      W.showOnly('pay');
      watchForTransfer();
      return;
    }
    W.showOnly('amount');
  }).catch(function (e) { W.fatal(e.message); });

  /* ── 1 · how much ─────────────────────────────────────────────────── */

  function syncAmount() {
    var amount = W.parseAmount(W.$('amount').value);
    W.$('continue').disabled = !(amount > 0);
    W.show(W.$('amount-err'), false);
    var chips = W.$('chips').children;
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = Number(chips[i].getAttribute('data-amount')) === amount ? 'on' : '';
    }
  }
  W.$('amount').addEventListener('input', function () { W.formatAmountInput(this); syncAmount(); });
  W.$('chips').addEventListener('click', function (event) {
    var amount = event.target && event.target.getAttribute('data-amount');
    if (!amount) return;
    W.$('amount').value = Number(amount).toLocaleString('en-NG');
    syncAmount();
  });

  /** They say what they want in the wallet; the server says what to send. */
  W.$('continue').addEventListener('click', function () {
    var button = this;
    var amount = W.parseAmount(W.$('amount').value);
    button.disabled = true;
    W.api('GET', '/wallet-page/deposit-preview?amount=' + encodeURIComponent(amount)).then(function (p) {
      W.$('pay-amount').textContent = W.naira(p.sendNgn);
      W.$('row-gets').textContent = W.naira(p.walletGetsNgn);
      W.showOnly('pay');
      watchForTransfer();
    }).catch(function (e) {
      W.$('amount-err').textContent = e.message;
      W.show(W.$('amount-err'), true);
    }).then(function () { button.disabled = !(W.parseAmount(W.$('amount').value) > 0); });
  });

  /* ── 2 · send it ──────────────────────────────────────────────────── */

  W.$('change').addEventListener('click', function () { W.showOnly('amount'); W.$('amount').focus(); });

  W.$('copy').addEventListener('click', function () {
    var button = this;
    W.copy(W.$('acct-number').textContent).then(function (ok) {
      if (!ok) return W.toast('Press and hold the number to copy');
      button.textContent = 'Copied ✓';
      W.toast('Account number copied');
      setTimeout(function () { button.textContent = 'Copy account number'; }, 2000);
    });
  });

  /** Poll gently while the page is visible; give up quietly after ten minutes. */
  function watchForTransfer() {
    if (watching) return;
    watching = true;
    var started = Date.now();
    var timer = setInterval(function () {
      if (document.hidden) return;
      if (Date.now() - started > 10 * 60 * 1000) {
        clearInterval(timer);
        W.show(W.$('waiting'), false);
        return;
      }
      W.api('GET', '/wallet-page/session').then(function (s) {
        var total = s.balanceNgn + (s.lockedNgn || 0);
        if (total > startingBalance + 0.004) {
          clearInterval(timer);
          W.$('landed-title').innerHTML = '';
          W.$('landed-title').appendChild(document.createTextNode(W.naira(total - startingBalance) + ' '));
          var em = document.createElement('em');
          em.textContent = 'added';
          W.$('landed-title').appendChild(em);
          W.$('landed-text').textContent = ride
            ? 'Your driver is being confirmed. Their details are landing in your WhatsApp chat now.'
            : 'Your wallet balance is now ' + W.naira(s.balanceNgn) + '.';
          W.showOnly('landed');
        }
      }).catch(function (e) {
        if (e.status === 401) { clearInterval(timer); W.show(W.$('waiting'), false); }
      });
    }, 6000);
  }
})();
