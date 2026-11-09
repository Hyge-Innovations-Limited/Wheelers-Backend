(function () {
  'use strict';
  var W = window.Wheelers;
  W.firstView = 'amount';
  W.backFrom = { pay: 'amount' };
  var startingBalance = 0;
  var watching = false;
  var checking = false;
  var account = null;        // { bankName, accountNumber, accountName }
  var ride = null;           // { driverName, fareNgn, landsNgn, sendNgn } when this deposit is to take a driver

  if (!W.takeToken()) {
    W.fatal('This link is not valid.');
    return;
  }

  /** 9912483620 reads as 9912 483 620, as in the app. Anything that is not ten digits is left alone. */
  function groupAccountNumber(number) {
    var digits = String(number).replace(/\s/g, '');
    if (!/^\d{10}$/.test(digits)) return String(number);
    return digits.slice(0, 4) + ' ' + digits.slice(4, 7) + ' ' + digits.slice(7);
  }

  W.api('GET', '/wallet-page/session').then(function (s) {
    if (s.scope !== 'deposit') return W.fatal('This link is for something else.');
    if (s.needsPhone) return W.showOnly('needs-phone');
    if (!s.account) return W.fatal('Your account number is still being prepared. Try again in a minute.');
    // Held money counts: a ride top-up is locked for the fare within a second of
    // landing, so the spendable balance alone can look as if nothing arrived.
    startingBalance = s.balanceNgn + (s.lockedNgn || 0);
    account = s.account;
    W.$('balance').textContent = W.naira(s.balanceNgn);
    W.$('acct-bank').textContent = account.bankName;
    W.$('acct-number').textContent = groupAccountNumber(account.accountNumber);
    W.$('acct-name').textContent = account.accountName;

    // Sent here from the chat to take a driver: they already know what they are
    // paying for, so skip "how much?" and open on the figure to send.
    if (s.rideTopup) {
      ride = s.rideTopup;
      var driver = String(ride.driverName || 'your driver').split(' ')[0];
      W.$('amount').value = Number(ride.landsNgn).toLocaleString('en-NG');
      syncAmount();
      W.$('pay-amount').textContent = W.naira(ride.sendNgn);
      W.$('needed-title').textContent = 'Add at least ' + W.naira(ride.landsNgn) + ' for your next ride';
      W.$('needed-text').textContent = 'Balance ' + W.naira(s.balanceNgn) + '. Ride with ' + driver + ' at ' + W.naira(ride.fareNgn) + '.';
      W.show(W.$('needed-text'), true);
      W.$('waiting-text').textContent = 'Waiting for your transfer — ' + driver + ' is confirmed the moment it lands';
      W.go('pay');
      watchForTransfer();
      return;
    }
    W.showOnly('amount');
  }).catch(function (e) { W.fatal(e.message); });

  /* ── 1 · how much ─────────────────────────────────────────────────── */

  function syncAmount() {
    var input = W.$('amount');
    var amount = W.parseAmount(input.value);
    W.$('continue').disabled = !(amount > 0);
    W.show(W.$('amount-err'), false);
    // The figure shrinks as it grows, as in the app.
    var length = input.value.length;
    W.$('amount-row').className = 'amount-row' + (length <= 6 ? '' : length <= 9 ? ' mid' : ' long');
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
      W.$('needed-title').textContent = W.naira(p.walletGetsNgn) + ' lands in your wallet';
      W.go('pay');
      watchForTransfer();
    }).catch(function (e) {
      W.$('amount-err').textContent = e.message;
      W.show(W.$('amount-err'), true);
    }).then(function () { button.disabled = !(W.parseAmount(W.$('amount').value) > 0); });
  });

  /* ── 2 · send it ──────────────────────────────────────────────────── */

  W.$('copy').addEventListener('click', function () {
    var button = this;
    if (!account) return;
    W.copy(account.accountNumber).then(function (ok) {
      if (!ok) return W.toast('Press and hold the number to copy');
      button.textContent = 'Copied';
      button.setAttribute('aria-label', 'Account number copied');
      setTimeout(function () {
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy account number');
      }, 2000);
    });
  });

  W.$('share').addEventListener('click', function () {
    if (!account) return;
    var text = account.bankName + '\n' + account.accountNumber + '\n' + account.accountName;
    if (navigator.share) {
      // Dismissed, or not allowed here: nothing to do.
      navigator.share({ text: text }).catch(function () {});
      return;
    }
    W.copy(text).then(function (ok) {
      W.toast(ok ? 'Account details copied' : 'Press and hold the number to copy');
    });
  });

  /** "I have made the transfer": look now instead of at the next tick. */
  W.$('made').addEventListener('click', function () {
    var button = this;
    if (checking) return;
    button.classList.add('busy');
    checkForTransfer().then(function (landed) {
      button.classList.remove('busy');
      if (!landed) W.toast(W.$('waiting-text').textContent);
    });
  });

  var timer = null;

  /** True once the money is in; then shows it. */
  function checkForTransfer() {
    if (checking) return Promise.resolve(false);
    checking = true;
    return W.api('GET', '/wallet-page/session').then(function (s) {
      checking = false;
      var total = s.balanceNgn + (s.lockedNgn || 0);
      if (!(total > startingBalance + 0.004)) return false;
      clearInterval(timer);
      W.$('landed-title').textContent = W.naira(total - startingBalance) + ' added';
      W.$('landed-text').textContent = ride
        ? 'Your driver is being confirmed. Their details are landing in your WhatsApp chat now.'
        : 'Your wallet balance is now ' + W.naira(s.balanceNgn) + '.';
      W.showOnly('landed');
      return true;
    }, function (e) {
      checking = false;
      if (e.status === 401) { clearInterval(timer); W.show(W.$('waiting'), false); }
      return false;
    });
  }

  /** Poll gently while the page is visible; give up quietly when the link itself would have (30 min). */
  function watchForTransfer() {
    if (watching) return;
    watching = true;
    var started = Date.now();
    timer = setInterval(function () {
      if (document.hidden) return;
      if (Date.now() - started > 30 * 60 * 1000) {
        clearInterval(timer);
        W.show(W.$('waiting'), false);
        return;
      }
      checkForTransfer();
    }, 6000);
  }
})();
