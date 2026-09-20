(function () {
  'use strict';
  var W = window.Wheelers;
  var startingBalance = 0;
  var watching = false;

  if (!W.takeToken()) {
    W.fatal('This link is not valid.');
    return;
  }

  W.api('GET', '/wallet-page/session').then(function (s) {
    if (s.scope !== 'deposit') return W.fatal('This link is for something else.');
    if (s.needsPhone) return W.showOnly('needs-phone');
    if (!s.account) return W.fatal('Your account number is still being prepared. Try again in a minute.');
    startingBalance = s.balanceNgn;
    W.$('balance').textContent = W.naira(s.balanceNgn);
    W.$('acct-bank').textContent = s.account.bankName;
    W.$('acct-number').textContent = s.account.accountNumber;
    W.$('acct-name').textContent = s.account.accountName;
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

  /** The server owns the fee maths. Ask once, when they commit to an amount. */
  W.$('continue').addEventListener('click', function () {
    var button = this;
    var amount = W.parseAmount(W.$('amount').value);
    button.disabled = true;
    W.api('GET', '/wallet-page/deposit-preview?mode=send&amount=' + encodeURIComponent(amount)).then(function (p) {
      if (!(p.walletGetsNgn > 0)) {
        W.$('amount-err').textContent = 'That’s too small to cover the charges. Try a larger amount.';
        W.show(W.$('amount-err'), true);
        return;
      }
      W.$('pay-amount').textContent = W.naira(p.sendNgn);
      W.$('row-send').textContent = W.naira(p.sendNgn);
      W.$('row-bank').textContent = '− ' + W.naira(p.bankChargeNgn);
      W.show(W.$('row-bank-line'), p.bankChargeNgn > 0);
      W.$('row-fee').textContent = '− ' + W.naira(p.wheelersFeeNgn);
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
        if (s.balanceNgn > startingBalance + 0.004) {
          clearInterval(timer);
          W.$('landed-title').innerHTML = '';
          W.$('landed-title').appendChild(document.createTextNode(W.naira(s.balanceNgn - startingBalance) + ' '));
          var em = document.createElement('em');
          em.textContent = 'added';
          W.$('landed-title').appendChild(em);
          W.$('landed-text').textContent = 'Your wallet balance is now ' + W.naira(s.balanceNgn) + '.';
          W.showOnly('landed');
        }
      }).catch(function (e) {
        if (e.status === 401) { clearInterval(timer); W.show(W.$('waiting'), false); }
      });
    }, 6000);
  }
})();
