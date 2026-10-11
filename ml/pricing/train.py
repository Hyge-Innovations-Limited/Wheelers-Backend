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
"""
import argparse
import json
import os
import time

import numpy as np
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


def score(exported, X):
    """Score exported trees exactly as the gateway does. Used to prove the export is right."""
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
    return 1 / (1 + np.exp(-out)) if exported['kind'] == 'chance' else out


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


def choose(models, w, today):
    """The model's price for each trip: the dearest of the prices that are worth within 1.5% of the best."""
    grid = candidates(today)
    n, c = grid.shape
    rep = {k: np.repeat(v, c, axis=0) for k, v in w.items() if isinstance(v, np.ndarray) and v.ndim == 1}
    X = W.feature_rows(rep, grid.reshape(-1))
    chance = models['requested'].predict_proba(X)[:, 1] * models['answered'].predict_proba(X)[:, 1] * models['agreed'].predict_proba(X)[:, 1]
    paid = grid.reshape(-1) * np.clip(models['paid'].predict(X), 0.7, 1.3)
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
    args = parser.parse_args()
    started = time.time()

    w, shown, out = W.quotes(args.rows, seed=101)
    X = W.feature_rows(w, shown)
    hw, hshown, hout = W.quotes(max(50_000, args.rows // 5), seed=202)     # never trained on
    HX = W.feature_rows(hw, hshown)
    print(f'{args.rows:,} quotes made in {time.time() - started:.0f}s: '
          f'{100 * out["requested"].mean():.0f}% requested, {100 * out["answered"].mean():.0f}% answered by a driver, {100 * out["ride"].mean():.0f}% became rides')

    asked, got = out['requested'], out['answered']
    models = {
        'requested': fit('chance', X, out['requested'], -1),
        'answered': fit('chance', X[asked], out['answered'][asked], +1),
        'agreed': fit('chance', X[got], out['ride'][got], -1),
        'paid': fit('amount', X[out['ride']], (out['paid'] / shown)[out['ride']]),
    }
    print(f'models fitted in {time.time() - started:.0f}s')

    exported = {
        'requested': export(models['requested'], 'chance'), 'answered': export(models['answered'], 'chance'),
        'agreed': export(models['agreed'], 'chance'), 'paid': export(models['paid'], 'amount'),
    }
    # The export must score exactly as scikit-learn does, or the gateway would price with a different model.
    sample = HX[:400]
    for name, model in models.items():
        theirs = model.predict_proba(sample)[:, 1] if name != 'paid' else model.predict(sample)
        gap = float(np.abs(theirs - score(exported[name], sample)).max())
        assert gap < 1e-4, f'{name}: the exported trees disagree with the fitted model by {gap}'

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
        chosen = choose(models, ew, today)
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
        'source': 'simulated',
        'rows': args.rows,
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
    print(json.dumps({'quality': quality, 'policy': policy}, indent=1))


if __name__ == '__main__':
    main()
