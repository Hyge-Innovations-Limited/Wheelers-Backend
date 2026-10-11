"""
A made-up Lagos ride market, for training and checking the pricing model.

Nothing here is measured from Wheelers trips. It is built around the two real
prices we have from the other app, and assumptions for everything else:

  the other app   15.5 km in 23 min on a clear Sunday road cost N5,800, and
                  16 km in 33 min cost N7,200. Taken as
                  (500 + 268 x km + 50 x minutes) x how busy the market is.
  riders          each has a most-they-will-pay, a little either side of the
                  cheapest other app. They walk away from a price far above
                  it, and four in ten bargain down as far as they are let.
  drivers         each has a lowest pay per km (in pocket) that rises with the
                  minutes a km takes, the night, rain and a short trip. One
                  takes the rider's price if it pays that much; otherwise
                  they counter with what they need, up to the ceiling.

Every quote is one row: what Wheelers could see when it priced the trip, the
price it showed, and how it ended. `quotes()` shows a random price around
today's, so the model sees what happens above and below it.
"""
import numpy as np

VAT, COMMISSION, LEVY = 0.075, 0.10, 30.0
SERVICE_CHARGE, MIN_FARE, BASE_RATE = 350.0, 2500.0, 375.0
PREMIUM, LIFT_CAP, DRIVER_CEILING, MIN_OFFER_SHARE = 300.0, 1.5, 1.5, 0.9
# With the model on, the least a price may sit above the other app, and so the most a rider may bargain away.
MODEL_PREMIUM = 150.0

# What Wheelers believes the other app charges (the admin's Pricing page): quiet and rush.
QUIET = (500.0, 268.0, 50.0)
RUSH = (575.0, 308.0, 58.0)

HOUR_W = np.array([.6, .4, .3, .3, .5, 1.5, 4, 7.5, 8, 6, 4.5, 4.5, 5, 5, 4.8, 5, 6.5, 8.5, 8.5, 7, 5, 3.5, 2.2, 1.2])
HOUR_WE = np.array([1.2, 1, .7, .5, .5, .8, 1.5, 2.5, 3.5, 4.5, 5.5, 6, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6, 5, 3.5, 2.2])

# The columns the model is given, in this order. The gateway builds the same row (pricing-ml.ts).
FEATURES = ['km', 'minPerKm', 'hour', 'weekend', 'rush', 'night', 'demand', 'marketEst', 'fare', 'fareOverMarket']


def ceil50(x):
    return np.ceil(np.round(x, 2) / 50.0) * 50.0


def fare_from_trip(trip):
    return np.maximum(MIN_FARE, ceil50(np.maximum(0, trip) * (1 + VAT) + SERVICE_CHARGE))


def trip_of(fare):
    return np.maximum(0, fare - SERVICE_CHARGE) / (1 + VAT)


def trips(n, seed, rider_value=1.0):
    """n trips riders ask a price for, with everything hidden from Wheelers drawn too."""
    rng = np.random.default_rng(seed)
    weekend = rng.random(n) < 2 / 7
    hour = np.where(weekend, rng.choice(24, size=n, p=HOUR_WE / HOUR_WE.sum()), rng.choice(24, size=n, p=HOUR_W / HOUR_W.sum()))
    night = (hour >= 22) | (hour < 5)
    am = (hour >= 7) & (hour < 10)
    pm = (hour >= 16) & (hour < 20)
    rush = ~weekend & (am | pm)
    rain = rng.random(n) < 0.08

    km = np.clip(rng.lognormal(np.log(9.0), 0.6, n), 1.5, 60.0)
    tau = np.select([night, weekend, am, pm], [1.55, 1.75, 3.6, 3.9], default=2.2)
    tau = np.maximum(1.35, tau * rng.lognormal(0, 0.25, n) * np.where(rain, 1.35, 1.0))
    minutes = km * tau

    # how busy the whole market is: what the other apps' prices and the number of free drivers follow
    busy = np.select([weekend & night, night, weekend, am, pm], [1.4, 1.2, 1.0, 2.0, 2.3], default=1.0)
    busy = busy * np.where(rain, 1.5, 1.0) * rng.lognormal(0, 0.3, n)
    lift = np.log(np.maximum(busy, 1.0))

    f0 = QUIET[0] + QUIET[1] * km + QUIET[2] * minutes
    indrive = f0 * np.clip(1 + 0.12 * lift, 1, 1.5) * rng.lognormal(0, 0.05, n)
    bolt = 1.06 * f0 * np.clip(1 + 0.25 * lift, 1, 2.0) * rng.lognormal(0, 0.05, n)
    uber = 1.12 * f0 * np.clip(1 + 0.28 * lift, 1, 2.2) * rng.lognormal(0, 0.05, n)
    cheapest = np.minimum(indrive, np.minimum(bolt, uber))

    # what Wheelers can see
    q = np.where(rush[:, None], np.array(RUSH)[None, :], np.array(QUIET)[None, :])
    market_est = np.round(q[:, 0] + q[:, 1] * km + q[:, 2] * minutes, 2)
    known = rng.random(n) < 0.5                      # a launch zone with enough history to read its busyness
    demand = np.where(known, np.clip(1 + 0.3 * np.log(np.maximum(busy * rng.lognormal(0, 0.4, n), 1.0)), 1, 1.8), 1.0)
    demand = np.round(demand, 1)
    traffic_ratio = np.maximum(1.0, tau / 1.6)

    # riders and drivers
    want = cheapest * rng.lognormal(np.log(1.04 * rider_value), 0.16, n)
    haggler = rng.random(n) < 0.4
    free = rng.poisson(np.where(night, 0.5, 1.0) * 3.2 / busy ** 0.8)
    need = (150 + 95 * tau[:, None]) * (1 + 0.12 * night[:, None]) * (1 + 0.08 * rain[:, None]) * rng.lognormal(0, 0.15, (n, 5)) + 250.0 / km[:, None]
    markup = rng.uniform(0.02, 0.12, (n, 5))

    return dict(n=n, km=km, minutes=minutes, tau=tau, hour=hour, weekend=weekend, rush=rush, night=night, demand=demand,
                market_est=market_est, traffic_ratio=traffic_ratio, indrive=indrive, cheapest=cheapest,
                want=want, haggler=haggler, free=free, need=need, markup=markup)


def todays_price(w):
    """What is live now without the model: the higher of the floor and the rules. Also the room the model has."""
    plain = fare_from_trip(BASE_RATE * w['km'])
    T = np.minimum(0.6 + 0.4 * w['traffic_ratio'], 2.6)
    rate = np.minimum(BASE_RATE * T * w['demand'], np.maximum(BASE_RATE, 1.5 * 300 * (1 + 0.5 * (T - 1))))
    rules = fare_from_trip(np.round(np.round(rate) * w['km'], 2))
    floor = np.maximum(MIN_FARE, ceil50(w['market_est'] + PREMIUM))
    lift_limit = ceil50(np.maximum(floor, plain) * LIFT_CAP)
    base = np.maximum(floor, np.minimum(rules, lift_limit))
    return dict(base=base, floor=floor, plain=plain, lift_limit=lift_limit, market_est=w['market_est'])


def min_offer(suggested, bargain):
    by_share = fare_from_trip(trip_of(suggested) * MIN_OFFER_SHARE)
    return np.minimum(np.maximum(np.maximum(by_share, ceil50(suggested - bargain)), MIN_FARE), np.maximum(suggested, MIN_FARE))


def play(w, suggested, bargain=PREMIUM):
    """Show each rider `suggested` and play the trip out. `bargain` is how far under it a rider may offer.
    Returns how each ended and what was paid."""
    n, km, want = w['n'], w['km'], w['want']
    lowest = min_offer(suggested, bargain)
    requested = (suggested <= 1.15 * want) & (lowest <= want)
    # their offer: the suggested price if they can afford it and do not haggle, else as low as they are let
    offer = np.where((suggested <= want) & ~w['haggler'], suggested, np.maximum(lowest, np.minimum(suggested, np.floor(want / 50) * 50)))

    there = np.arange(5)[None, :] < np.minimum(w['free'], 5)[:, None]
    pay_per_km = (trip_of(offer) * (1 - COMMISSION) - LEVY) / km
    takes = there & (pay_per_km[:, None] >= w['need'])
    taken = takes.any(axis=1)
    # nobody takes it: each driver there counters with what they need and a little more, if the ceiling lets them
    counter = fare_from_trip((w['need'] * (1 + w['markup']) * km[:, None] + LEVY) / (1 - COMMISSION))
    ceiling = fare_from_trip(trip_of(suggested) * DRIVER_CEILING)
    ok = there & (counter <= ceiling[:, None])
    best = np.where(ok, counter, np.inf).min(axis=1)
    answered = taken | np.isfinite(best)
    price = np.where(taken, offer, best)
    ride = requested & answered & (price <= want)
    return dict(requested=requested, answered=requested & answered, ride=ride, paid=np.where(ride, price, np.nan), driver_there=w['free'] > 0)


def feature_rows(w, fare):
    return np.column_stack([
        w['km'], w['minutes'] / w['km'], w['hour'], w['weekend'], w['rush'], w['night'], w['demand'],
        w['market_est'], fare, fare / w['market_est'],
    ]).astype(np.float64)


def quotes(n, seed, rider_value=1.0):
    """n quotes at a random price around today's (from 22% under to 35% over), with how each ended."""
    w = trips(n, seed, rider_value)
    rng = np.random.default_rng(seed + 1)
    shown = np.maximum(MIN_FARE, ceil50(todays_price(w)['base'] * rng.uniform(0.78, 1.35, n)))
    out = play(w, shown, MODEL_PREMIUM)
    return w, shown, out
