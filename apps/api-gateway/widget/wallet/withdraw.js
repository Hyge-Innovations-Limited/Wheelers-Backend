(function () {
  'use strict';
  var W = window.Wheelers;
  var PIN_LENGTH = 4;

  var session = null;
  var banks = [];
  var draft = { amountNgn: 0, bankCode: '', bankName: '', accountNumber: '', accountName: '' };
  var resetCode = null;      // email code carried from "check your email" to "new PIN"
  var pinPurpose = 'create'; // what the create-PIN pad is for: 'create' | 'reset'
  var firstEntry = null;     // first of the two entries when choosing a PIN
  var submitKey = null;      // one idempotency key per tap of the last digit
  var resolveSeq = 0;

  if (!W.takeToken()) {
    W.fatal('This link is not valid.');
    return;
  }

  /* ── PIN pads ─────────────────────────────────────────────────────── */

  function buildPad(container, onDigit, onDelete) {
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(function (key) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = key;
      if (key === '') { button.className = 'fn'; button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
      if (key === '⌫') { button.className = 'fn'; button.setAttribute('aria-label', 'Delete'); }
      button.addEventListener('click', function () {
        if (key === '⌫') onDelete(); else if (key !== '') onDigit(key);
      });
      container.appendChild(button);
    });
  }

  function makePinEntry(dotsId, msgId, onComplete) {
    var value = '';
    var dots = W.$(dotsId).children;
    function paint() { for (var i = 0; i < dots.length; i++) dots[i].className = i < value.length ? 'on' : ''; }
    return {
      digit: function (d) {
        if (value.length >= PIN_LENGTH) return;
        W.$(msgId).textContent = '';
        value += d;
        paint();
        if (value.length === PIN_LENGTH) { var pin = value; setTimeout(function () { onComplete(pin); }, 120); }
      },
      del: function () { value = value.slice(0, -1); paint(); },
      clear: function () { value = ''; paint(); },
      fail: function (message) {
        value = '';
        paint();
        W.$(msgId).textContent = message;
        var box = W.$(dotsId);
        box.classList.remove('shake');
        void box.offsetWidth; // restart the animation
        box.classList.add('shake');
      },
    };
  }

  var createEntry = makePinEntry('create-dots', 'create-msg', onCreateEntered);
  var pinEntry = makePinEntry('pin-dots', 'pin-msg', submitWithdrawal);
  buildPad(document.querySelector('[data-pad="create"]'), createEntry.digit, createEntry.del);
  buildPad(document.querySelector('[data-pad="pin"]'), pinEntry.digit, pinEntry.del);

  /* ── boot ─────────────────────────────────────────────────────────── */

  W.api('GET', '/wallet-page/session').then(function (s) {
    if (s.scope !== 'withdraw') return W.fatal('This link is for something else.');
    session = s;
    W.$('balance').textContent = W.naira(s.balanceNgn);
    if (s.frozenUntil) {
      W.$('frozen-notice').textContent = s.frozenReason === 'pin_reset'
        ? 'Withdrawals are paused for ' + W.until(s.frozenUntil) + ' after your PIN reset. Deposits and rides work as normal.'
        : 'Withdrawals are paused on your account. Contact Wheelers support.';
      W.show(W.$('frozen-notice'), true);
      W.$('amount').disabled = true;
      W.$('max').disabled = true;
    } else if (s.restrictedUntil) {
      W.$('frozen-notice').textContent = 'For the next ' + W.until(s.restrictedUntil) + ', money can only go to a bank account you’ve withdrawn to before.';
      W.show(W.$('frozen-notice'), true);
    }
    W.showOnly('amount');
    return W.api('GET', '/wallet-page/banks').then(function (r) { banks = r.banks; renderBanks(''); });
  }).catch(function (e) { W.fatal(e.message); });

  document.addEventListener('click', function (event) {
    var back = event.target && event.target.getAttribute && event.target.getAttribute('data-back');
    if (back) { pinEntry.clear(); W.showOnly(back); }
  });

  /* ── 1 · amount ───────────────────────────────────────────────────── */

  function checkAmount() {
    var amount = W.parseAmount(W.$('amount').value);
    var hint = 'No Wheelers fee on withdrawals.';
    var ok = amount > 0;
    if (amount > session.balanceNgn) { ok = false; hint = 'You can withdraw up to ' + W.naira(session.balanceNgn) + '.'; }
    else if (amount > 0 && amount < session.minWithdrawalNgn) { ok = false; hint = 'Banks can’t receive less than ' + W.naira(session.minWithdrawalNgn) + '.'; }
    W.$('amount-hint').textContent = hint;
    W.$('to-bank').disabled = !ok || Boolean(session.frozenUntil);
    draft.amountNgn = amount;
  }
  W.$('amount').addEventListener('input', function () { W.formatAmountInput(this); checkAmount(); });
  W.$('max').addEventListener('click', function () {
    W.$('amount').value = Math.floor(session.balanceNgn).toLocaleString('en-NG');
    checkAmount();
  });
  W.$('to-bank').addEventListener('click', function () {
    W.$('bank-lede').textContent = 'Sending ' + W.naira(draft.amountNgn) + '.';
    W.showOnly('bank');
  });

  /* ── 2 · destination ──────────────────────────────────────────────── */

  function renderBanks(query) {
    var list = W.$('banklist');
    list.textContent = '';
    var q = query.trim().toLowerCase();
    var matches = banks.filter(function (b) { return !q || b.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 40);
    if (matches.length === 0) {
      var none = document.createElement('div');
      none.className = 'none';
      none.textContent = banks.length ? 'No bank matches “' + query + '”.' : 'Loading banks…';
      list.appendChild(none);
      return;
    }
    matches.forEach(function (bank) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = bank.name;
      button.addEventListener('click', function () { pickBank(bank); });
      list.appendChild(button);
    });
  }
  W.$('bank-q').addEventListener('input', function () { renderBanks(this.value); });

  function pickBank(bank) {
    draft.bankCode = bank.code;
    draft.bankName = bank.name;
    W.$('bank-name').textContent = bank.name;
    W.show(W.$('bank-search'), false);
    W.show(W.$('bank-picked'), true);
    W.show(W.$('acct-field'), true);
    W.$('acct').focus();
    maybeResolve();
  }
  W.$('bank-change').addEventListener('click', function () {
    draft.bankCode = '';
    draft.accountName = '';
    W.show(W.$('bank-search'), true);
    W.show(W.$('bank-picked'), false);
    W.show(W.$('resolved'), false);
    W.$('to-confirm').disabled = true;
    W.$('bank-q').focus();
  });

  function setResolved(kind, text) {
    var el = W.$('resolved');
    el.className = 'resolved ' + kind;
    el.textContent = text;
    W.show(el, true);
  }

  /** Ten digits + a bank = look the holder up. Only the latest lookup counts. */
  function maybeResolve() {
    var number = W.$('acct').value.replace(/\D/g, '');
    W.$('acct').value = number;
    draft.accountNumber = number;
    draft.accountName = '';
    W.$('to-confirm').disabled = true;
    if (number.length !== 10 || !draft.bankCode) { W.show(W.$('resolved'), false); return; }

    var seq = ++resolveSeq;
    setResolved('wait', 'Checking the account…');
    W.api('POST', '/wallet-page/resolve-account', { bankCode: draft.bankCode, accountNumber: number }).then(function (r) {
      if (seq !== resolveSeq) return;
      draft.accountName = r.accountName;
      draft.accountNumber = r.accountNumber;
      setResolved('ok', '✓ ' + r.accountName);
      W.$('to-confirm').disabled = false;
    }).catch(function (e) {
      if (seq !== resolveSeq) return;
      setResolved('err', e.message);
    });
  }
  W.$('acct').addEventListener('input', maybeResolve);

  W.$('to-confirm').addEventListener('click', function () {
    W.$('c-amount').textContent = W.naira(draft.amountNgn);
    W.$('c-total').textContent = W.naira(draft.amountNgn);
    W.$('c-name').textContent = draft.accountName;
    W.$('c-acct').textContent = draft.bankName + ' · ' + draft.accountNumber;
    if (session.hasPin) { pinEntry.clear(); W.showOnly('confirm'); }
    else startPinChoice('create');
  });

  /* ── 3 · choosing a PIN (first time, or after "Forgot PIN") ────────── */

  function startPinChoice(purpose) {
    pinPurpose = purpose;
    firstEntry = null;
    createEntry.clear();
    W.$('create-msg').textContent = '';
    W.$('create-title').textContent = purpose === 'reset' ? 'Choose a new PIN' : 'Create your wallet PIN';
    W.$('create-lede').textContent = 'Four digits. You’ll enter it every time you withdraw, so nobody else can move your money.';
    W.showOnly('create-pin');
  }

  function onCreateEntered(pin) {
    if (firstEntry === null) {
      firstEntry = pin;
      createEntry.clear();
      W.$('create-title').textContent = 'Enter it once more';
      W.$('create-lede').textContent = 'Just to be sure you typed it right.';
      return;
    }
    if (pin !== firstEntry) {
      firstEntry = null;
      W.$('create-title').textContent = pinPurpose === 'reset' ? 'Choose a new PIN' : 'Create your wallet PIN';
      createEntry.fail('Those didn’t match. Start again.');
      return;
    }

    var request = pinPurpose === 'reset'
      ? W.api('POST', '/wallet-page/pin-reset/complete', { newPin: pin, code: resetCode })
      : W.api('POST', '/wallet-page/pin', { pin: pin });

    request.then(function (r) {
      session.hasPin = true;
      if (pinPurpose === 'reset') {
        resetCode = null;
        if (r.frozenUntil) {
          return showResult(true, 'PIN changed', 'Withdrawals are paused for ' + W.until(r.frozenUntil) + ' to keep your money safe. Come back after that — deposits and rides work as normal.');
        }
        W.toast('PIN changed');
        pinEntry.clear();
        return W.showOnly('confirm');
      }
      session.justSetPin = pin; // held in memory only, to finish this withdrawal without retyping
      W.showOnly('email');
    }).catch(function (e) {
      firstEntry = null;
      W.$('create-title').textContent = pinPurpose === 'reset' ? 'Choose a new PIN' : 'Create your wallet PIN';
      createEntry.fail(e.message);
      if (e.code === 'CODE_WRONG' || e.code === 'CODE_EXPIRED' || e.code === 'CODE_LOCKED') W.showOnly('confirm');
    });
  }

  /* recovery email — optional, right after creating a PIN */
  function afterEmailStep() {
    var pin = session.justSetPin;
    session.justSetPin = null;
    if (pin) return submitWithdrawal(pin);
    pinEntry.clear();
    W.showOnly('confirm');
  }
  W.$('email-skip').addEventListener('click', afterEmailStep);
  W.$('email-skip-2').addEventListener('click', afterEmailStep);

  W.$('email-send').addEventListener('click', function () {
    var button = this;
    var email = W.$('email').value.trim();
    W.show(W.$('email-err'), false);
    if (!email) return afterEmailStep();
    button.disabled = true;
    W.api('POST', '/wallet-page/recovery-email/start', { email: email, pin: session.justSetPin }).then(function (r) {
      W.$('email-code-lede').textContent = 'We sent a 6-digit code to ' + r.sentTo + '.';
      W.showOnly('email-code');
    }).catch(function (e) {
      W.$('email-err').textContent = e.message;
      W.show(W.$('email-err'), true);
    }).then(function () { button.disabled = false; });
  });

  W.$('email-verify').addEventListener('click', function () {
    var button = this;
    W.show(W.$('email-code-err'), false);
    button.disabled = true;
    W.api('POST', '/wallet-page/recovery-email/verify', { code: W.$('email-code').value.trim() }).then(function () {
      W.toast('Recovery email added');
      afterEmailStep();
    }).catch(function (e) {
      W.$('email-code-err').textContent = e.message;
      W.show(W.$('email-code-err'), true);
    }).then(function () { button.disabled = false; });
  });

  /* ── forgot PIN ───────────────────────────────────────────────────── */

  W.$('forgot').addEventListener('click', function () {
    W.api('POST', '/wallet-page/pin-reset/start', {}).then(function (r) {
      if (r.method === 'email') {
        W.$('reset-code-lede').textContent = 'We sent a 6-digit code to ' + r.sentTo + '.';
        W.$('reset-code').value = '';
        W.$('reset-code-next').disabled = true;
        return W.showOnly('reset-code');
      }
      W.showOnly('reset-warn');
    }).catch(function (e) { W.$('pin-msg').textContent = e.message; });
  });
  W.$('reset-go').addEventListener('click', function () { resetCode = null; startPinChoice('reset'); });
  W.$('reset-code').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '');
    W.$('reset-code-next').disabled = this.value.length !== 6;
  });
  W.$('reset-code-next').addEventListener('click', function () {
    resetCode = W.$('reset-code').value;
    startPinChoice('reset');
  });

  /* ── 4 · submit ───────────────────────────────────────────────────── */

  function submitWithdrawal(pin) {
    // One key per attempt: a double tap or a retried request can never send twice.
    submitKey = submitKey || W.uuid();
    W.showOnly('sending');
    W.api('POST', '/wallet-page/withdraw', {
      amountNgn: draft.amountNgn,
      bankCode: draft.bankCode,
      accountNumber: draft.accountNumber,
      accountName: draft.accountName,
      pin: pin,
    }, { 'Idempotency-Key': submitKey }).then(function () {
      showResult(true, W.naira(draft.amountNgn) + ' on its way', 'To ' + draft.accountName + ' · ' + draft.bankName + '. It usually arrives within minutes.');
    }).catch(function (e) {
      submitKey = null; // a refused attempt may be retried as a NEW request
      if (e.code === 'PIN_WRONG' || e.code === 'PIN_REQUIRED') {
        W.showOnly('confirm');
        return pinEntry.fail(e.message);
      }
      if (e.code === 'PENDING_CONFIRMATION') {
        return showResult(true, 'Submitted', e.message);
      }
      showResult(false, 'Not sent', e.message, e.code !== 'PIN_LOCKED' && e.code !== 'WITHDRAWALS_FROZEN' && e.status !== 401);
    });
  }

  function showResult(ok, title, text, canRetry) {
    W.$('result-box').className = ok ? 'done' : 'done fail';
    W.$('result-tick').textContent = ok ? '✓' : '!';
    W.$('result-title').textContent = title;
    W.$('result-text').textContent = text;
    W.show(W.$('result-again'), Boolean(canRetry));
    W.showOnly('result');
  }
  W.$('result-again').addEventListener('click', function () { pinEntry.clear(); W.showOnly('confirm'); });
})();
