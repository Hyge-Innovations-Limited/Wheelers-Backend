(function () {
  'use strict';
  var W = window.Wheelers;
  var mode = 'send';
  var startingBalance = 0;
  var previewTimer = null;
  var previewSeq = 0;

  if (!W.takeToken()) {
    W.fatal('This link is not valid.');
    return;
  }

  W.api('GET', '/wallet-page/session').then(function (s) {
    if (s.scope !== 'deposit') return W.fatal('This link is for something else.');
    if (s.needsPhone) return W.showOnly('needs-phone');
    if (!s.account) return W.fatal('Your account number is still being prepared. Try again in a minute.');
    startingBalance = s.balanceNgn;
    W.$('greeting').textContent = s.firstName ? 'Add money, ' + s.firstName : 'Add money';
    W.$('balance').textContent = W.naira(s.balanceNgn);
    W.$('acct-bank').textContent = s.account.bankName;
    W.$('acct-number').textContent = s.account.accountNumber;
    W.$('acct-name').textContent = s.account.accountName;
    W.showOnly('main');
    watchForTransfer();
  }).catch(function (e) { W.fatal(e.message); });

  function setMode(next) {
    mode = next;
    W.$('mode-send').setAttribute('aria-pressed', String(next === 'send'));
    W.$('mode-receive').setAttribute('aria-pressed', String(next === 'receive'));
    schedulePreview();
  }
  W.$('mode-send').addEventListener('click', function () { setMode('send'); });
  W.$('mode-receive').addEventListener('click', function () { setMode('receive'); });

  W.$('amount').addEventListener('input', function () { W.formatAmountInput(this); schedulePreview(); });
  W.$('chips').addEventListener('click', function (event) {
    var amount = event.target && event.target.getAttribute('data-amount');
    if (!amount) return;
    W.$('amount').value = Number(amount).toLocaleString('en-NG');
    schedulePreview();
  });

  /** The server owns the fee maths; the page only asks. Debounced while typing. */
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 220);
  }
  function preview() {
    var amount = W.parseAmount(W.$('amount').value);
    if (!(amount > 0)) {
      W.show(W.$('breakdown'), false);
      W.show(W.$('sendline'), false);
      return;
    }
    var seq = ++previewSeq;
    W.api('GET', '/wallet-page/deposit-preview?mode=' + mode + '&amount=' + encodeURIComponent(amount)).then(function (p) {
      if (seq !== previewSeq) return; // a newer keystroke already asked
      W.$('row-send').textContent = W.naira(p.sendNgn);
      W.$('row-bank').textContent = '− ' + W.naira(p.bankChargeNgn);
      W.show(W.$('row-bank-line'), p.bankChargeNgn > 0);
      W.$('row-fee').textContent = '− ' + W.naira(p.wheelersFeeNgn);
      W.$('row-gets').textContent = W.naira(p.walletGetsNgn);
      W.$('send-exact').textContent = W.naira(p.sendNgn);
      W.show(W.$('breakdown'), true);
      W.show(W.$('sendline'), true);
    }).catch(function () { /* keep the last good preview on a blip */ });
  }

  W.$('copy').addEventListener('click', function () {
    W.copy(W.$('acct-number').textContent).then(function (ok) {
      W.toast(ok ? 'Account number copied' : 'Press and hold the number to copy');
    });
  });

  /** Poll gently while the page is visible; stop after ten minutes. */
  function watchForTransfer() {
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
          W.$('landed-title').textContent = W.naira(s.balanceNgn - startingBalance) + ' added';
          W.$('landed-text').textContent = 'Your wallet balance is now ' + W.naira(s.balanceNgn) + '.';
          W.showOnly('landed');
        }
      }).catch(function (e) {
        if (e.status === 401) { clearInterval(timer); W.show(W.$('waiting'), false); }
      });
    }, 6000);
  }
})();
