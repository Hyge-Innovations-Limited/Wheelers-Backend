(function () {
  'use strict';
  var W = window.Wheelers;
  W.firstView = 'amount';
  // Bank account and Confirm both open from the Withdraw screen and close back to it.
  W.backFrom = { bank: 'amount', confirm: 'amount' };
  function currentStep() { var v = document.querySelector('[data-view]:not([hidden])'); return v ? v.getAttribute('data-view') : null; }
  var PIN_LENGTH = 4;
  /** Round amounts offered as one-tap choices, when the balance allows them (as in the app). */
  var QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];

  var session = null;
  var banks = [];
  var banksLoaded = false;
  // What will be sent: filled in when an account has been checked on the Bank account screen.
  var draft = { amountNgn: 0, bankCode: '', bankName: '', accountNumber: '', accountName: '' };
  // What is being typed on the Bank account screen, until it is checked.
  var pick = { bankCode: '', bankName: '', accountNumber: '', accountName: '' };
  var pendingResolve = null; // the latest account lookup, resolving to true when the bank named the holder
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
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].forEach(function (key) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = key === 'del' ? 'Delete' : key;
      if (key === '') { button.className = 'fn'; button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
      if (key === 'del') { button.className = 'fn'; button.setAttribute('aria-label', 'Delete'); }
      button.addEventListener('click', function () {
        if (key === 'del') onDelete(); else if (key !== '') onDigit(key);
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
      W.$('frozen-text').textContent = s.frozenReason === 'pin_reset'
        ? 'For your safety, withdrawals are paused for ' + W.until(s.frozenUntil) + ' after your PIN reset. Deposits and rides work as normal.'
        : 'Withdrawals are paused on your account. Contact Wheelers support to lift it.';
      W.show(W.$('frozen-notice'), true);
      W.$('amount').disabled = true;
    } else if (s.restrictedUntil) {
      W.show(W.$('frozen-title'), false);
      W.$('frozen-text').textContent = 'For the next ' + W.until(s.restrictedUntil) + ', money can only go to a bank account you’ve withdrawn to before.';
      W.show(W.$('frozen-notice'), true);
    }
    renderQuick();
    checkAmount();
    W.showOnly('amount');
    renderBanks('');
    return W.api('GET', '/wallet-page/banks').then(function (r) { banks = r.banks; banksLoaded = true; renderBanks(W.$('bank-q').value); });
  }).catch(function (e) {
    if (!session) return W.fatal(e.message);
    // The page is up; only the bank list failed. Say so where the list goes.
    renderBanks(W.$('bank-q').value, e.message);
  });

  // "Back" and "Cancel": close this screen. Through the history when this
  // screen put an entry there, so the phone's own back stays in step.
  document.addEventListener('click', function (event) {
    var back = event.target && event.target.getAttribute && event.target.getAttribute('data-back');
    if (!back) return;
    pinEntry.clear();
    var here = currentStep();
    if (W.backFrom[here] === back) W.back();
    else if (history.state && history.state.view === here) history.back();
    else W.showOnly(back);
  });

  /* ── 1 · the Withdraw screen ──────────────────────────────────────── */

  /* The fee comes out of the amount: the wallet gives up what was typed, the bank gets the rest. */
  function feeNgn() { return Number(session.withdrawalFeeNgn) || 0; }
  function receiveNgn(amount) { return Math.max(0, Math.round((amount - feeNgn()) * 100) / 100); }
  function minNgn() { return Number(session.minWithdrawalNgn) || 0; }

  /** Only amounts the server would accept from this balance: the two largest round ones under it, and All. */
  function renderQuick() {
    var box = W.$('quick');
    box.textContent = '';
    var balance = session.balanceNgn;
    var all = Math.floor(balance);
    function allowed(amount) { return amount > 0 && amount <= balance && (minNgn() <= 0 || amount >= minNgn()); }
    var choices = QUICK_AMOUNTS.filter(function (amount) { return amount < all && allowed(amount); }).slice(-2)
      .map(function (amount) { return { amount: amount, label: W.naira(amount) }; });
    if (allowed(all)) choices.push({ amount: all, label: 'All' });
    choices.forEach(function (choice) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.setAttribute('data-amount', String(choice.amount));
      button.setAttribute('aria-label', choice.label === 'All' ? 'Withdraw all, ' + W.naira(choice.amount) : 'Withdraw ' + choice.label);
      button.disabled = Boolean(session.frozenUntil);
      button.addEventListener('click', function () {
        W.$('amount').value = choice.amount.toLocaleString('en-NG');
        checkAmount();
      });
      box.appendChild(button);
    });
    W.show(box, choices.length > 0);
  }

  function setHint(text, isError) {
    var el = W.$('amount-hint');
    el.textContent = text;
    el.className = 'small ' + (isError ? 'danger' : 'muted');
    W.show(el, Boolean(text));
  }

  function checkAmount() {
    var input = W.$('amount');
    var amount = W.parseAmount(input.value);
    var ok = amount > 0;
    var fee = feeNgn();

    // The figure shrinks as it grows, as in the app.
    var length = input.value.length;
    W.$('amount-row').className = 'amount-row' + (length <= 6 ? '' : length <= 9 ? ' mid' : ' long');

    var chips = W.$('quick').children;
    for (var i = 0; i < chips.length; i++) chips[i].className = Number(chips[i].getAttribute('data-amount')) === amount ? 'on' : '';

    W.$('fee-line').textContent = amount > 0
      ? W.naira(fee) + ' withdrawal fee · you receive ' + W.naira(receiveNgn(amount))
      : W.naira(fee) + ' fee on every withdrawal';
    W.show(W.$('fee-line'), fee > 0);

    if (amount > session.balanceNgn) {
      ok = false;
      setHint('You have insufficient balance for this withdrawal. Available balance is ' + W.naira(Math.round(session.balanceNgn)) + '.', true);
    } else if (amount > 0 && amount < minNgn()) {
      ok = false;
      setHint('The least you can withdraw is ' + W.naira(minNgn()) + (fee > 0 ? ', including the ' + W.naira(fee) + ' withdrawal fee.' : '.'), true);
    } else if (amount > 0) {
      var remaining = session.balanceNgn - amount;
      setHint(remaining < 1 ? 'Your wallet balance will be ₦0.' : W.naira(remaining) + ' will remain in your wallet.', false);
    } else {
      setHint('', false);
    }

    W.$('to-bank').textContent = amount > 0 ? 'Withdraw ' + W.naira(amount) : 'Withdraw';
    W.$('to-bank').disabled = !ok || Boolean(session.frozenUntil);
    draft.amountNgn = amount;
  }
  W.$('amount').addEventListener('input', function () { submitKey = null; W.formatAmountInput(this); checkAmount(); });

  function paintPayee() {
    var has = Boolean(draft.accountName);
    W.$('payee-title').textContent = has ? draft.bankName + ' · ending ' + draft.accountNumber.slice(-4) : 'No bank account yet';
    W.$('payee-sub').textContent = has ? draft.accountName : 'Choose where the money goes.';
    W.$('payee-change').textContent = has ? 'Change' : 'Add';
    W.$('payee-change').setAttribute('aria-label', has ? 'Change bank account' : 'Add a bank account');
  }

  function openBank() {
    W.go('bank');
    if (!pick.bankCode) W.$('bank-q').focus();
  }
  W.$('payee-change').addEventListener('click', openBank);

  /** The main button: no account yet → choose one; otherwise show what will happen. */
  W.$('to-bank').addEventListener('click', function () {
    if (!draft.accountName) return openBank();
    var fee = feeNgn();
    W.$('c-amount').textContent = W.naira(draft.amountNgn);
    W.$('c-fee').textContent = '− ' + W.naira(fee);
    W.show(W.$('c-fee-row'), fee > 0);
    W.$('c-total').textContent = W.naira(receiveNgn(draft.amountNgn));
    W.$('c-name').textContent = draft.accountName;
    W.$('c-bank').textContent = draft.bankName;
    W.$('c-acct').textContent = draft.accountNumber;
    W.go('confirm');
  });

  /* ── 2 · Bank account ─────────────────────────────────────────────── */

  var CHEVRON = '<svg viewBox="0 0 512 512" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48" d="M184 112l144 144-144 144"/></svg>';

  function renderBanks(query, error) {
    var list = W.$('banklist');
    list.textContent = '';
    var q = query.trim().toLowerCase();
    var matches = banks.filter(function (b) { return !q || b.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 40);
    if (matches.length === 0) {
      var state = document.createElement('div');
      state.className = 'bank-list-state';
      if (!banksLoaded && !error) {
        state.appendChild(document.createElement('span')).className = 'spinner';
      } else {
        var text = document.createElement('p');
        text.className = 'small muted';
        text.textContent = error || 'No banks matched your search.';
        state.appendChild(text);
      }
      list.appendChild(state);
      return;
    }
    matches.forEach(function (bank) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'bank-row';
      button.setAttribute('aria-label', bank.name);
      var name = document.createElement('span');
      name.textContent = bank.name;
      button.appendChild(name);
      button.insertAdjacentHTML('beforeend', CHEVRON);
      button.addEventListener('click', function () { pickBank(bank); });
      list.appendChild(button);
    });
  }
  W.$('bank-q').addEventListener('input', function () { renderBanks(this.value); });

  function pickBank(bank) {
    pick.bankCode = bank.code;
    pick.bankName = bank.name;
    W.$('bank-name').textContent = bank.name;
    W.show(W.$('bank-search'), false);
    W.show(W.$('bank-picked'), true);
    W.show(W.$('acct-field'), true);
    W.show(W.$('to-confirm'), true);
    W.$('acct').focus();
    maybeResolve();
  }
  W.$('bank-change').addEventListener('click', function () {
    resolveSeq++;
    pendingResolve = null;
    pick.bankCode = '';
    pick.accountName = '';
    W.show(W.$('bank-search'), true);
    W.show(W.$('bank-picked'), false);
    W.show(W.$('acct-field'), false);
    W.show(W.$('to-confirm'), false);
    setResolved('', 'We check the name on the account before any money moves.');
    W.$('bank-q').focus();
  });

  /** The line under the account number: the hint, the check, the name, or what went wrong. */
  function setResolved(kind, text) {
    W.$('resolved').className = 'field-hint' + (kind ? ' ' + kind : '');
    W.$('resolved').textContent = text;
    W.$('acct').className = 'input num' + (kind === 'error' ? ' error' : kind === 'ok' ? ' valid' : '');
    W.show(W.$('acct-tick'), kind === 'ok');
  }

  /** Ten digits + a bank = look the holder up. Only the latest lookup counts. */
  function maybeResolve() {
    var number = W.$('acct').value.replace(/\D/g, '');
    W.$('acct').value = number;
    pick.accountNumber = number;
    pick.accountName = '';
    pendingResolve = null;
    W.$('to-confirm').disabled = true;
    if (number.length !== 10 || !pick.bankCode) {
      resolveSeq++;
      setResolved('', 'We check the name on the account before any money moves.');
      return;
    }

    var seq = ++resolveSeq;
    setResolved('', 'Checking the account…');
    W.$('to-confirm').disabled = false;
    pendingResolve = W.api('POST', '/wallet-page/resolve-account', { bankCode: pick.bankCode, accountNumber: number }).then(function (r) {
      if (seq !== resolveSeq) return false;
      pick.accountName = r.accountName;
      pick.accountNumber = r.accountNumber;
      setResolved('ok', r.accountName);
      return true;
    }, function (e) {
      if (seq !== resolveSeq) return false;
      setResolved('error', e.message);
      W.$('to-confirm').disabled = true;
      return false;
    });
  }
  W.$('acct').addEventListener('input', maybeResolve);

  /** "Check account": once the bank has named the holder, this is where the money goes. */
  W.$('to-confirm').addEventListener('click', function () {
    var button = this;
    if (!pendingResolve) return;
    button.classList.add('busy');
    pendingResolve.then(function (ok) {
      button.classList.remove('busy');
      if (!ok || !pick.accountName) return;
      submitKey = null;
      draft.bankCode = pick.bankCode;
      draft.bankName = pick.bankName;
      draft.accountNumber = pick.accountNumber;
      draft.accountName = pick.accountName;
      paintPayee();
      W.back();
    });
  });

  /* ── 3 · Confirm, then the PIN ────────────────────────────────────── */

  W.$('confirm-go').addEventListener('click', function () {
    if (session.hasPin) { pinEntry.clear(); W.$('pin-msg').textContent = ''; W.go('pin'); }
    else startPinChoice('create');
  });

  /* choosing a PIN (first time, or after "Forgot PIN") */
  function startPinChoice(purpose) {
    pinPurpose = purpose;
    firstEntry = null;
    createEntry.clear();
    W.$('create-msg').textContent = '';
    W.$('create-title').textContent = purpose === 'reset' ? 'Choose a new PIN' : 'Create your wallet PIN';
    W.$('create-lede').textContent = purpose === 'reset'
      ? 'Four digits you’ll remember and nobody else will guess.'
      : 'Four digits. You’ll enter it every time you withdraw, so nobody else can move your money.';
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
      startPinChoice(pinPurpose);
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
          return showResult({ icon: 'check', title: 'PIN changed', text: 'Withdrawals are paused for ' + W.until(r.frozenUntil) + ' to keep your money safe. Deposits and rides work as normal.' });
        }
        W.toast('PIN changed');
        pinEntry.clear();
        return W.showOnly('pin');
      }
      session.justSetPin = pin; // held in memory only, to finish this withdrawal without retyping
      W.showOnly('email');
    }).catch(function (e) {
      if (e.code === 'CODE_WRONG' || e.code === 'CODE_EXPIRED' || e.code === 'CODE_LOCKED') {
        W.$('reset-code-err').textContent = e.message;
        W.show(W.$('reset-code-err'), true);
        return W.showOnly('reset-code');
      }
      startPinChoice(pinPurpose);
      createEntry.fail(e.message);
    });
  }

  /* recovery email — optional, right after creating a PIN */
  function afterEmailStep() {
    var pin = session.justSetPin;
    session.justSetPin = null;
    if (pin) return submitWithdrawal(pin);
    pinEntry.clear();
    W.showOnly('pin');
  }
  W.$('email-skip').addEventListener('click', afterEmailStep);
  W.$('email-skip-2').addEventListener('click', afterEmailStep);

  W.$('email-send').addEventListener('click', function () {
    var button = this;
    var email = W.$('email').value.trim();
    W.show(W.$('email-err'), false);
    W.$('email').className = 'input';
    if (!email) return afterEmailStep();
    button.disabled = true;
    W.api('POST', '/wallet-page/recovery-email/start', { email: email, pin: session.justSetPin }).then(function (r) {
      W.$('email-code-lede').textContent = 'We sent a 6-digit code to ' + r.sentTo + '.';
      W.showOnly('email-code');
    }).catch(function (e) {
      W.$('email-err').textContent = e.message;
      W.$('email').className = 'input error';
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
  W.$('email-code').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });

  /* forgot PIN */
  W.$('forgot').addEventListener('click', function () {
    W.$('pin-msg').textContent = '';
    W.api('POST', '/wallet-page/pin-reset/start', {}).then(function (r) {
      if (r.method === 'email') {
        W.$('reset-code-lede').textContent = 'We sent a 6-digit code to ' + r.sentTo + '.';
        W.$('reset-code').value = '';
        W.$('reset-code-next').disabled = true;
        W.show(W.$('reset-code-err'), false);
        return W.showOnly('reset-code');
      }
      W.showOnly('reset-warn');
    }).catch(function (e) { W.$('pin-msg').textContent = e.message; });
  });
  W.$('reset-go').addEventListener('click', function () { resetCode = null; startPinChoice('reset'); });
  W.$('reset-code').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
    W.show(W.$('reset-code-err'), false);
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
    }, { 'Idempotency-Key': submitKey }).then(function (r) {
      // What the bank gets: the server's figure when it gives one, else the amount less the fee.
      var received = r && typeof r.payoutNgn === 'number' ? r.payoutNgn : receiveNgn(draft.amountNgn);
      var settled = r && r.status === 'SETTLED';
      showResult({
        icon: settled ? 'check' : 'time',
        title: settled ? 'Withdrawal sent' : 'Withdrawal on its way',
        text: settled
          ? W.naira(received) + ' sent to your bank.'
          : W.naira(received) + ' is on its way. We’ll update your wallet once the bank confirms.',
        detail: draft.bankName + ' · ending ' + draft.accountNumber.slice(-4) + ' · ' + draft.accountName,
      });
    }).catch(function (e) {
      submitKey = null; // a refused attempt may be retried as a NEW request
      if (e.code === 'PIN_WRONG' || e.code === 'PIN_REQUIRED') {
        W.showOnly('pin');
        return pinEntry.fail(e.message);
      }
      if (e.code === 'PENDING_CONFIRMATION') {
        return showResult({ icon: 'time', title: 'Submitted', text: e.message });
      }
      showResult({
        icon: 'alert',
        title: 'Withdrawal failed',
        text: e.message,
        canRetry: e.code !== 'PIN_LOCKED' && e.code !== 'WITHDRAWALS_FROZEN' && e.status !== 401,
      });
    });
  }

  function showResult(result) {
    W.$('result-icon').className = 'outcome-icon' + (result.icon === 'alert' ? ' bad' : '');
    W.show(W.$('icon-check'), result.icon === 'check');
    W.show(W.$('icon-time'), result.icon === 'time');
    W.show(W.$('icon-alert'), result.icon === 'alert');
    W.$('result-title').textContent = result.title;
    W.$('result-text').textContent = result.text;
    W.$('result-detail').textContent = result.detail || '';
    W.show(W.$('result-detail'), Boolean(result.detail));
    W.show(W.$('result-again'), Boolean(result.canRetry));
    W.show(W.$('result-foot'), result.icon !== 'alert');
    W.showOnly('result');
  }
  W.$('result-again').addEventListener('click', function () { pinEntry.clear(); W.showOnly('confirm'); });
})();
