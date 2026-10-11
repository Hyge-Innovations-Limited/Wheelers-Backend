"""
Train the pricing model on a million made-up quotes and write it where the
gateway reads it (packages/config/models/pricing-ml.json).

    pip install -r ml/pricing/requirements.txt
    python ml/pricing/train.py                 # a million quotes, about two minutes
    python ml/pricing/train.py --rows 200000   # a quick run

Four small gradient-boosted tree models, each answering one question about a
trip shown at a price:

    requested   will the rider ask for the ride at all?        (falls as the price rises)
    answered    will a driver take it or counter?              (rises with the price)
    agreed      once a driver answers, do they agree?          (falls as the price rises)
    paid        what share of the shown price is finally paid

The first three are forced to move the right way with price, whatever the
data says, so the model can never decide a dearer trip is more likely to be
booked. Multiplied together they are the chance a quote becomes a ride; the
gateway tries a handful of prices around today's and shows the one worth
most (see choose() here and pricing-ml.ts, which must stay the same).

Trees are written out as plain arrays, so the gateway scores them with a
loop: no ML library and no model server in production.

Learning from real quotes
-------------------------
    node scripts/run-with-env.cjs node scripts/export-pricing-quotes.mjs    # on the server: writes ml/pricing/data/real-quotes.csv
    python ml/pricing/train.py --real ml/pricing/data/real-quotes.csv       # here

Real quotes are few at first, far too few to grow trees from. So the trees
stay as trained on the made-up market, and each of the four models gets a
small correction fitted on the real quotes alone:

    real chance = sigmoid(a + b x (what the trees said) + c x ln(price / the other app's price))

Three numbers a model, pulled toward "the trees were right" (a 0, b 1, c 0)
so a handful of quotes cannot swing it, and never allowed to turn a model
the wrong way round on price. From 3,000 real quotes the trees themselves
are regrown on the real quotes and an equal weight of made-up ones.

The newest fifth of the real quotes is held back: the corrected model must
predict those better than the model already shipped, or nothing is written
(--force writes it anyway).
"""
import argparse
import json
import os
import time

import csv

import numpy as np
from scipy.optimize import minimize
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import brier_score_loss, roc_auc_score

import world as W

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'packages', 'config', 'models', 'pricing-ml.json'))

# The room the model has, and what a ride is worth: the gateway's defaults (pricing settings).
MAX_DISCOUNT_NGN, MAX_DISCOUNT_SHARE, RIDE_VALUE_NGN = 700.0, 0.10, 500.0
STEPS_DOWN, STEPS_UP, NEAR_BEST = 13, 12, 0.985

FARE, FARE_OVER_MARKET = W.FEATURES.index('fare'), W.FEATURES.index('fareOverMarket')


def monotone(direction):
    cst = [0] * len(W.FEATURES)
    cst[FARE] = direction
    cst[FARE_OVER_MARKET] = direction
    return cst


def fit(kind, X, y, direction=0):
    args = dict(max_iter=80, max_leaf_nodes=16, learning_rate=0.12, min_samples_leaf=200, l2_regularization=1.0,
                monotonic_cst=monotone(direction), random_state=7)
    model = HistGradientBoostingClassifier(**args) if kind == 'chance' else HistGradientBoostingRegressor(**args)
    return model.fit(X, y)


def export(model, kind):
    """The fitted trees as flat arrays: at node i go left when x[feature[i]] <= threshold[i]; a leaf has feature -1."""
    trees = []
    for stage in model._predictors:
        nodes = stage[0].nodes
        trees.append({
            'f': [-1 if n['is_leaf'] else int(n['feature_idx']) for n in nodes],
            't': [0 if n['is_leaf'] else float(n['num_threshold']) for n in nodes],
            'l': [0 if n['is_leaf'] else int(n['left']) for n in nodes],
            'r': [0 if n['is_leaf'] else int(n['right']) for n in nodes],
            'v': [float(np.format_float_positional(n['value'], precision=7, unique=False, fractional=False)) if n['is_leaf'] else 0 for n in nodes],
        })
    return {'kind': kind, 'base': float(np.ravel(model._baseline_prediction)[0]), 'trees': trees}


def raw(exported, X):
    """What the trees alone say, before any correction from real quotes."""
    out = np.full(len(X), exported['base'])
    for tree in exported['trees']:
        f, t, l, r, v = (np.array(tree[k]) for k in 'ftlrv')
        node = np.zeros(len(X), dtype=int)
        for _ in range(64):
            feat = f[node]
            live = feat >= 0
            if not live.any():
                break
            go_left = X[np.arange(len(X)), np.where(live, feat, 0)] <= t[node]
            node = np.where(live, np.where(go_left, l[node], r[node]), node)
        out += v[node]
    return out


def score(exported, X):
    """Score an exported model exactly as the gateway does (pricing-ml.ts): the trees, then the correction
    fitted on real quotes when there is one. Used to prove the export is right."""
    out = raw(exported, X)
    adjust = exported.get('adjust')
    if exported['kind'] == 'chance':
        if adjust:
            out = adjust['a'] + adjust['b'] * out + adjust['c'] * np.log(X[:, FARE_OVER_MARKET])
        return 1 / (1 + np.exp(-out))
    return adjust['a'] + adjust['b'] * out if adjust else out


# ── learning from real quotes ────────────────────────────────────────────────

REAL_MIN, REAL_REGROW = 60, 3000
PRIOR = 30.0          # how hard the correction is held to "the trees were right": worth about this many quotes


def read_real(path):
    """The real quotes the server exported: one row a rider's request for a price, oldest first."""
    with open(path, newline='') as handle:
        rows = list(csv.DictReader(handle))
    rows.sort(key=lambda r: r['at'])
    X = np.array([[float(r[name]) for name in W.FEATURES] for r in rows], dtype=np.float64).reshape(-1, len(W.FEATURES))
    flag = lambda name: np.array([r[name] == '1' for r in rows], dtype=bool)
    paid = np.array([float(r['paid']) if r['paid'] else np.nan for r in rows])
    return X, {'requested': flag('requested'), 'answered': flag('answered'), 'ride': flag('ride'), 'paid': paid}


def correct(exported, X, y, direction):
    """a, b, c for one chance model, from real quotes alone. `direction` is the way it must move with price."""
    z, r = raw(exported, X), np.log(X[:, FARE_OVER_MARKET])
    n = len(y)

    def loss(theta):
        a, b, c = theta
        logit = a + b * z + c * r
        fit_loss = np.mean(np.logaddexp(0, logit) - y * logit)
        return fit_loss + PRIOR / max(n, 1) * (a * a + (b - 1) ** 2 + 0.05 * c * c)

    # b never negative (the trees' order is kept); c only ever pushes the way price is allowed to act.
    bounds = [(-6, 6), (0.05, 4), (0, 12) if direction > 0 else (-12, 0)]
    best = minimize(loss, x0=[0.0, 1.0, 0.0], bounds=bounds, method='L-BFGS-B')
    return {'a': float(best.x[0]), 'b': float(best.x[1]), 'c': float(best.x[2])}


def correct_amount(exported, X, y):
    z = raw(exported, X)
    n = len(y)
    best = minimize(lambda t: np.mean((t[0] + t[1] * z - y) ** 2) * 50 + PRIOR / max(n, 1) * (t[0] ** 2 + (t[1] - 1) ** 2),
                    x0=[0.0, 1.0], bounds=[(-0.5, 0.5), (0.2, 2)], method='L-BFGS-B')
    return {'a': float(best.x[0]), 'b': float(best.x[1])}


def with_corrections(exported, X, y):
    """The same trees with each model corrected on these real quotes. A model with too few to go on keeps its last correction."""
    out = {name: {k: v for k, v in model.items()} for name, model in exported.items()}
    asked, got, rode = y['requested'], y['answered'] & y['requested'], y['ride']
    if len(X) >= REAL_MIN:
        out['requested']['adjust'] = correct(exported['requested'], X, y['requested'].astype(float), -1)
    if asked.sum() >= REAL_MIN // 2:
        out['answered']['adjust'] = correct(exported['answered'], X[asked], y['answered'][asked].astype(float), +1)
    if got.sum() >= REAL_MIN // 2:
        out['agreed']['adjust'] = correct(exported['agreed'], X[got], y['ride'][got].astype(float), -1)
    if rode.sum() >= REAL_MIN // 2:
        out['paid']['adjust'] = correct_amount(exported['paid'], X[rode], (y['paid'] / X[:, FARE])[rode])
    return out


def ride_chance(exported, X):
    return score(exported['requested'], X) * score(exported['answered'], X) * score(exported['agreed'], X)


def miss(exported, X, rode):
    """How wrong a model is about which quotes became rides (log loss: lower is better)."""
    p = np.clip(ride_chance(exported, X), 1e-6, 1 - 1e-6)
    return float(-np.mean(np.where(rode, np.log(p), np.log(1 - p))))


def candidates(today):
    """The prices tried for each trip: a few hundred naira either side of today's, never closer to the other
    app than MODEL_PREMIUM and never past the lift limit."""
    base = today['base']
    room = np.minimum(MAX_DISCOUNT_NGN, MAX_DISCOUNT_SHARE * base)
    hi = np.maximum(base, np.minimum(today['lift_limit'], base + room))
    least = W.ceil50(today['market_est'] + W.MODEL_PREMIUM)          # never closer to the other app than this
    lo = np.minimum(base, np.maximum(np.maximum(least, base - room), W.MIN_FARE))
    down = lo[:, None] + (base - lo)[:, None] * np.linspace(0, 1, STEPS_DOWN)[None, :]
    up = base[:, None] + (hi - base)[:, None] * (np.arange(1, STEPS_UP + 1) / STEPS_UP)[None, :]
    return W.ceil50(np.concatenate([down, up], axis=1))


def quick(models, exported, name, X):
    """The same answer as score(exported[name], X), from scikit-learn's own (much faster) trees. For millions of rows."""
    adjust = exported[name].get('adjust')
    if exported[name]['kind'] == 'chance':
        z = models[name].decision_function(X)
        if adjust:
            z = adjust['a'] + adjust['b'] * z + adjust['c'] * np.log(X[:, FARE_OVER_MARKET])
        return 1 / (1 + np.exp(-z))
    z = models[name].predict(X)
    return adjust['a'] + adjust['b'] * z if adjust else z


def choose(models, exported, w, today):
    """The model's price for each trip: the dearest of the prices that are worth within 1.5% of the best."""
    grid = candidates(today)
    n, c = grid.shape
    rep = {k: np.repeat(v, c, axis=0) for k, v in w.items() if isinstance(v, np.ndarray) and v.ndim == 1}
    X = W.feature_rows(rep, grid.reshape(-1))
    chance = quick(models, exported, 'requested', X) * quick(models, exported, 'answered', X) * quick(models, exported, 'agreed', X)
    paid = grid.reshape(-1) * np.clip(quick(models, exported, 'paid', X), 0.7, 1.3)
    worth = (chance * (W.SERVICE_CHARGE + W.COMMISSION * W.trip_of(paid) + RIDE_VALUE_NGN)).reshape(n, c)
    good = worth >= NEAR_BEST * worth.max(axis=1, keepdims=True)
    return np.where(good, grid, -np.inf).max(axis=1)


def outcome(w, shown, bargain):
    r = W.play(w, shown, bargain)
    paid = np.nan_to_num(r['paid'])
    trip = W.trip_of(paid)
    rides = r['ride']
    return {
        'ridesPer100Quotes': round(100 * rides.mean(), 2),
        'avgShownNgn': round(float(shown.mean())),
        'avgPaidNgn': round(float(paid[rides].mean())),
        'wheelersPer100QuotesNgn': round(float(100 * np.where(rides, W.SERVICE_CHARGE + W.COMMISSION * trip, 0).mean())),
        'driversPer100QuotesNgn': round(float(100 * np.where(rides, trip * (1 - W.COMMISSION) - W.LEVY, 0).mean())),
        'driverPerRideNgn': round(float((trip[rides] * (1 - W.COMMISSION) - W.LEVY).mean())),
        'medianShownOverInDriveNgn': round(float(np.median(shown - w['indrive']))),
        'shownUnderInDrivePct': round(float(100 * (shown < w['indrive']).mean()), 1),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rows', type=int, default=1_000_000)
    parser.add_argument('--out', default=OUT)
    parser.add_argument('--real', help='real quotes exported from the server (scripts/export-pricing-quotes.mjs)')
    parser.add_argument('--force', action='store_true', help='write the model even if it does not beat the one shipped on the held-back real quotes')
    args = parser.parse_args()
    started = time.time()

    real = read_real(args.real) if args.real else None
    n_real = len(real[0]) if real else 0
    if real is not None:
        ry = real[1]
        print(f'{n_real:,} real quotes read: {ry["requested"].sum():,} requested, {(ry["answered"] & ry["requested"]).sum():,} answered by a driver, {ry["ride"].sum():,} became rides')

    w, shown, out = W.quotes(args.rows, seed=101)
    X = W.feature_rows(w, shown)
    hw, hshown, hout = W.quotes(max(50_000, args.rows // 5), seed=202)     # never trained on
    HX = W.feature_rows(hw, hshown)
    print(f'{args.rows:,} quotes made in {time.time() - started:.0f}s: '
          f'{100 * out["requested"].mean():.0f}% requested, {100 * out["answered"].mean():.0f}% answered by a driver, {100 * out["ride"].mean():.0f}% became rides')

    def grow(X, shown, labels):
        asked, got, rode = labels['requested'], labels['answered'] & labels['requested'], labels['ride']
        models = {
            'requested': fit('chance', X, labels['requested'], -1),
            'answered': fit('chance', X[asked], labels['answered'][asked], +1),
            'agreed': fit('chance', X[got], labels['ride'][got], -1),
            'paid': fit('amount', X[rode], (labels['paid'] / shown)[rode]),
        }
        return models, {name: export(model, 'amount' if name == 'paid' else 'chance') for name, model in models.items()}

    # From 3,000 real quotes the trees are regrown on them and an equal weight of made-up ones.
    # Below that the trees are the made-up market's, and real quotes only correct them (further down).
    labels = {'requested': out['requested'], 'answered': out['answered'], 'ride': out['ride'], 'paid': out['paid']}
    grown_on = 'simulated'
    judged = None            # the same trees grown WITHOUT the held-back real quotes, to be judged on them
    if n_real >= REAL_REGROW:
        keep = np.random.default_rng(9).choice(len(X), size=min(len(X), n_real), replace=False)
        rX, ry = real
        mix = lambda upto: (np.vstack([X[keep], rX[:upto]]), np.concatenate([shown[keep], rX[:upto, FARE]]),
                            {k: np.concatenate([labels[k][keep], ry[k][:upto]]) for k in labels})
        _, judged = grow(*mix(int(n_real * 0.8)))
        X, shown, labels = mix(n_real)
        grown_on = 'simulated+real'
        print(f'trees regrown on {n_real:,} real quotes and {len(keep):,} made-up ones')
    models, exported = grow(X, shown, labels)
    print(f'models fitted in {time.time() - started:.0f}s')

    # The export must score exactly as scikit-learn does, or the gateway would price with a different model.
    sample = HX[:400]
    for name, model in models.items():
        theirs = model.predict_proba(sample)[:, 1] if name != 'paid' else model.predict(sample)
        gap = float(np.abs(theirs - score(exported[name], sample)).max())
        assert gap < 1e-4, f'{name}: the exported trees disagree with the fitted model by {gap}'

    # Real quotes: correct each model on them, and prove on the newest fifth (held back) that it helped.
    real_report = None
    if real is not None and n_real < REAL_MIN:
        print(f'only {n_real} real quotes: fewer than the {REAL_MIN} needed to learn anything from. The model is as the made-up market taught it.')
        real_report = {'quotes': n_real, 'used': False}
    elif real is not None:
        rX, ry = real
        cut = int(n_real * 0.8)
        old, new = slice(0, cut), slice(cut, n_real)
        trees = judged or exported
        trial = with_corrections(trees, rX[old], {k: v[old] for k, v in ry.items()})
        shipped = None
        try:
            with open(args.out) as handle:
                shipped = json.load(handle)['models']
        except (OSError, ValueError, KeyError):
            pass
        real_report = {
            'quotes': n_real, 'heldBack': n_real - cut, 'used': True,
            'missUncorrected': round(miss(trees, rX[new], ry['ride'][new]), 4),
            'missCorrected': round(miss(trial, rX[new], ry['ride'][new]), 4),
            'missShipped': round(miss(shipped, rX[new], ry['ride'][new]), 4) if shipped else None,
            'heldBackRidePct': round(float(100 * ry['ride'][new].mean()), 1),
            'saidUncorrectedPct': round(float(100 * ride_chance(trees, rX[new]).mean()), 1),
            'saidCorrectedPct': round(float(100 * ride_chance(trial, rX[new]).mean()), 1),
        }
        against = real_report['missShipped'] if shipped else real_report['missUncorrected']
        real_report['better'] = real_report['missCorrected'] < against
        print('on the newest real quotes (held back):', json.dumps(real_report))
        if not real_report['better'] and not args.force:
            print('The corrected model does not predict the held-back real quotes better than the one shipped. Nothing written (--force to write anyway).')
            return
        # It earned its place: the corrections that ship are fitted on every real quote.
        exported = with_corrections(exported, rX, ry)
        real_report['corrections'] = {name: model.get('adjust') for name, model in exported.items()}

    # How good is it on quotes it never saw?
    hasked, hgot = hout['requested'], hout['answered']
    p_req = models['requested'].predict_proba(HX)[:, 1]
    p_ans = models['answered'].predict_proba(HX)[:, 1]
    p_agr = models['agreed'].predict_proba(HX)[:, 1]
    p_ride = p_req * p_ans * p_agr
    order = np.argsort(p_ride)
    tenths = np.array_split(order, 10)
    quality = {
        'heldBackQuotes': int(len(HX)),
        'requested': {'auc': round(roc_auc_score(hout['requested'], p_req), 3), 'brier': round(brier_score_loss(hout['requested'], p_req), 4)},
        'answered': {'auc': round(roc_auc_score(hout['answered'][hasked], p_ans[hasked]), 3), 'brier': round(brier_score_loss(hout['answered'][hasked], p_ans[hasked]), 4)},
        'agreed': {'auc': round(roc_auc_score(hout['ride'][hgot], p_agr[hgot]), 3), 'brier': round(brier_score_loss(hout['ride'][hgot], p_agr[hgot]), 4)},
        'becameRide': {'auc': round(roc_auc_score(hout['ride'], p_ride), 3), 'predictedPct': round(100 * p_ride.mean(), 2), 'actualPct': round(100 * hout['ride'].mean(), 2)},
        # quotes sorted by the model's chance, in ten groups: what it said against what happened
        'byTenth': [{'saidPct': round(100 * p_ride[i].mean(), 1), 'happenedPct': round(100 * hout['ride'][i].mean(), 1)} for i in tenths],
        'paidShareError': round(float(np.abs(models['paid'].predict(HX[hout['ride']]) - (hout['paid'] / hshown)[hout['ride']]).mean()), 4),
    }

    # What would it do to prices and rides? The same fresh trips at today's price and at the model's,
    # in the market it was trained on and in two it was not (riders who value Wheelers less, and more).
    policy = {}
    for label, value in (('asTrained', 1.0), ('ridersValueUsLess', 0.94), ('ridersValueUsMore', 1.08)):
        ew = W.trips(150_000, seed=303, rider_value=value)
        today = W.todays_price(ew)
        chosen = choose(models, exported, ew, today)
        change = chosen - today['base']
        cut = change < 0
        policy[label] = {
            'today': outcome(ew, today['base'], W.PREMIUM),
            'model': outcome(ew, chosen, W.MODEL_PREMIUM),
            'change': {
                'loweredPct': round(float(100 * cut.mean()), 1), 'samePct': round(float(100 * (change == 0).mean()), 1), 'raisedPct': round(float(100 * (change > 0).mean()), 1),
                'medianCutNgn': round(float(np.median(-change[cut]))) if cut.any() else 0,
                'cutP10Ngn': round(float(np.percentile(-change[cut], 10))) if cut.any() else 0,
                'cutP90Ngn': round(float(np.percentile(-change[cut], 90))) if cut.any() else 0,
                'largestCutNgn': round(float((-change).max())),
                'cutSizes': {f'{lo}-{lo + 99}': round(float(100 * ((-change >= lo) & (-change < lo + 100)).mean()), 1) for lo in range(1, 800, 100)},
                'medianRaiseNgn': round(float(np.median(change[change > 0]))) if (change > 0).any() else 0,
                'byTimeMedianChangeNgn': {
                    'quiet': round(float(np.median(change[~ew['rush'] & ~ew['night'] & ~ew['weekend']]))),
                    'rush': round(float(np.median(change[ew['rush']]))),
                    'night': round(float(np.median(change[ew['night']]))),
                    'weekend': round(float(np.median(change[ew['weekend'] & ~ew['night']]))),
                },
            },
        }

    # Rows the gateway's own scorer is checked against, so a change on either side that breaks the match fails a test.
    checks = [{'x': [float(v) for v in row], 'requested': float(a), 'answered': float(b), 'agreed': float(c), 'paid': float(d)}
              for row, a, b, c, d in zip(sample[:40], *(score(exported[k], sample[:40]) for k in ('requested', 'answered', 'agreed', 'paid')))]

    artifact = {
        'version': 1,
        'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': grown_on if not (real_report and real_report.get('used')) else 'simulated+real',
        'rows': args.rows,
        'realRows': n_real if real_report and real_report.get('used') else 0,
        'real': real_report,
        'features': W.FEATURES,
        'choice': {'stepsDown': STEPS_DOWN, 'stepsUp': STEPS_UP, 'nearBest': NEAR_BEST},
        'models': exported,
        'checks': checks,
        'quality': quality,
        'policy': policy,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as handle:
        json.dump(artifact, handle, separators=(',', ':'))
    print(f'written to {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB) in {time.time() - started:.0f}s\n')
    print(json.dumps({'real': real_report, 'quality': quality, 'policy': policy}, indent=1))


if __name__ == '__main__':
    main()
