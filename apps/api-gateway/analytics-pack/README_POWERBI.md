# Wheelers — Power BI model (snowflake schema)

30 CSVs ready to load into Power BI: **18 dimensions (`dim_`) + 12 facts (`fact_`)**, plus `_relationships.csv`
listing every relationship to create. Simulated data for October 2026 — not real Wheelers traffic.

## Design rules

1. **Every attribute lives in exactly one table.** A driver's age, car ownership, engine size and how they joined live
   once in `dim_driver` / `dim_vehicle` — not on every ping and offer.
2. **Values that change over time stay on the fact row where they were observed.** Trips done today, revenue so far,
   remittance left, minutes since last trip are the driver's state *at the moment of that ping*, so they sit on
   `fact_request_notifications`. Offers reach them through the notification — nothing is copied onto offers.
3. **Nothing reachable through a relationship is repeated.** Route, channel, ride class and payment method are the
   same for every attempt of a ride request, so they live on `fact_ride_intents`, not on each session.
4. **Counts and sums are DAX measures, not stored columns.** (Measures below.)
5. **One active filter path between any two tables** — no ambiguity errors. Role-playing links are inactive; use
   `USERELATIONSHIP` when you need them.
6. Lookup dimensions carry readable names, flags (`is_bid`, `is_matched`…) and a `sort` column; every `_band` column
   has a `_band_sort` partner.
7. Datetimes are Lagos local time (WAT, UTC+1) as `YYYY-MM-DD HH:MM:SS`. `date_key` = `YYYYMMDD` (whole number).
   Booleans are `TRUE`/`FALSE`. Multi-valued rating tags are a bridge table.

## Shape of the model

```
                          dim_rider   dim_channel  dim_ride_class  dim_payment_method  dim_area  dim_intent_outcome
                                 \         \            |              /               /          /
                                  └──────────────── fact_ride_intents ───────────────────────────┘
                                                        │
 dim_date  dim_hour  dim_weather  dim_traffic_level ── fact_ride_sessions ── dim_session_outcome
     │      dim_experiment_variant  dim_pricing_version │  │  │  │
     │                                                   │  │  │  └── fact_trips ──┬── fact_payments
     │                                                   │  │  │         │         ├── fact_support_tickets
     │                                                   │  │  │         │         └── fact_trip_rating_tags
     │                                                   │  │  └── fact_session_events ── dim_event_type
     │                                                   │  └── fact_price_changes
     │                                                   └── fact_request_notifications ── dim_driver_action
     │                                                              │        └── fact_driver_offers ── dim_offer_status
     ├── fact_driver_shifts ──────┐                                 │
     └── fact_driver_wallet_ledger┴──────────── dim_driver ─────────┘ (also → fact_trips)
                                                    └── dim_vehicle
```

## Tables

| Table | One row per | Key |
|---|---|---|
| dim_date | calendar day, Apr–Nov 2026 (holiday, weekend, ISO week) | date_key |
| dim_hour | hour of day (day part, peak flag) | hour_key |
| dim_area | Lagos area (lat/lng, Mainland/Island, launch zone) | area_key |
| dim_channel / dim_ride_class / dim_payment_method | lookup | *_key |
| dim_traffic_level / dim_weather | lookup with fare multiplier / rain flag | *_key |
| dim_session_outcome / dim_intent_outcome | lookup with funnel flags | *_key |
| dim_driver_action / dim_offer_status / dim_event_type | lookup with flags / stage | *_key |
| dim_experiment_variant | A/B variant (offer timeout) | experiment_variant_key |
| dim_pricing_version | fare rules in force | pricing_version_key |
| dim_rider | rider profile | rider_id |
| dim_driver | driver profile (age band, ownership, remittance, join source, other platforms) | driver_id |
| dim_vehicle | car (make, model, year, engine litre/band, class, plate) | vehicle_id |
| fact_ride_intents | a rider's need to get from A to B, across retries | intent_id |
| fact_ride_sessions | one request attempt (rider history + market state at that moment) | session_id |
| fact_price_changes | one rider raise/drop | change_id |
| fact_session_events | one action, in order | event_id |
| fact_request_notifications | one driver pinged in one round (+ driver's state at that moment) | notification_id |
| fact_driver_offers | one offer (only what's new at the offer) | offer_id |
| fact_trips | one matched session | trip_id |
| fact_trip_rating_tags | one tag on one rating (bridge) | trip_id + tag |
| fact_payments | one charge attempt or refund | payment_id |
| fact_support_tickets | one ticket | ticket_id |
| fact_driver_shifts | one online period | shift_id |
| fact_driver_wallet_ledger | one wallet movement | entry_id |

## Relationships (all Many-to-one, single direction)

| From (many) | → To (one) | Active |
|---|---|---|
| fact_ride_intents[rider_id] | dim_rider[rider_id] | Yes |
| fact_ride_intents[channel_key] | dim_channel[channel_key] | Yes |
| fact_ride_intents[ride_class_key] | dim_ride_class[ride_class_key] | Yes |
| fact_ride_intents[payment_method_key] | dim_payment_method[payment_method_key] | Yes |
| fact_ride_intents[pickup_area_key] | dim_area[area_key] | Yes |
| fact_ride_intents[dropoff_area_key] | dim_area[area_key] | **No** (inactive) |
| fact_ride_intents[intent_outcome_key] | dim_intent_outcome[intent_outcome_key] | Yes |
| fact_ride_intents[first_opened_date_key] | dim_date[date_key] | **No** (inactive) |
| fact_ride_sessions[intent_id] | fact_ride_intents[intent_id] | Yes |
| fact_ride_sessions[date_key] | dim_date[date_key] | Yes |
| fact_ride_sessions[hour_key] | dim_hour[hour_key] | Yes |
| fact_ride_sessions[session_outcome_key] | dim_session_outcome[session_outcome_key] | Yes |
| fact_ride_sessions[experiment_variant_key] | dim_experiment_variant[experiment_variant_key] | Yes |
| fact_ride_sessions[pricing_version_key] | dim_pricing_version[pricing_version_key] | Yes |
| fact_ride_sessions[weather_key] | dim_weather[weather_key] | Yes |
| fact_ride_sessions[traffic_level_key] | dim_traffic_level[traffic_level_key] | Yes |
| fact_price_changes[session_id] | fact_ride_sessions[session_id] | Yes |
| fact_session_events[session_id] | fact_ride_sessions[session_id] | Yes |
| fact_session_events[event_type_key] | dim_event_type[event_type_key] | Yes |
| fact_request_notifications[session_id] | fact_ride_sessions[session_id] | Yes |
| fact_request_notifications[driver_id] | dim_driver[driver_id] | Yes |
| fact_request_notifications[driver_action_key] | dim_driver_action[driver_action_key] | Yes |
| fact_driver_offers[notification_id] | fact_request_notifications[notification_id] | Yes |
| fact_driver_offers[offer_status_key] | dim_offer_status[offer_status_key] | Yes |
| fact_trips[session_id] | fact_ride_sessions[session_id] | Yes |
| fact_trips[driver_id] | dim_driver[driver_id] | Yes |
| fact_trips[final_payment_method_key] | dim_payment_method[payment_method_key] | **No** (inactive) |
| fact_trip_rating_tags[trip_id] | fact_trips[trip_id] | Yes |
| fact_payments[trip_id] | fact_trips[trip_id] | Yes |
| fact_payments[payment_method_key] | dim_payment_method[payment_method_key] | **No** (inactive) |
| fact_support_tickets[trip_id] | fact_trips[trip_id] | Yes |
| fact_driver_shifts[driver_id] | dim_driver[driver_id] | Yes |
| fact_driver_shifts[date_key] | dim_date[date_key] | Yes |
| fact_driver_shifts[start_area_key] | dim_area[area_key] | **No** (inactive) |
| fact_driver_wallet_ledger[driver_id] | dim_driver[driver_id] | Yes |
| fact_driver_wallet_ledger[date_key] | dim_date[date_key] | Yes |
| dim_driver[vehicle_id] | dim_vehicle[vehicle_id] | Yes |
| dim_driver[home_area_key] | dim_area[area_key] | **No** (inactive) |
| dim_rider[home_area_key] | dim_area[area_key] | **No** (inactive) |

**Reference-only columns — do not create relationships on these** (they would create a second filter path):
`fact_ride_sessions[accepted_offer_id]`, `fact_ride_sessions[previous_session_id]`, `fact_trips[offer_id]`,
`fact_trips[shift_id]`, `fact_request_notifications[shift_id]`, `fact_request_notifications[last_trip_id]`,
`fact_session_events[offer_id]`, `fact_session_events[actor_id]`, `fact_driver_wallet_ledger[trip_id]`.

## Loading it

1. **File → Options → Current file → Data load:** untick *Autodetect new relationships after data is loaded*
   (otherwise Power BI guesses joins from column names).
2. **Get data → Text/CSV** for each file (or **Get data → Folder → Transform data**, then right-click each file's
   *Binary* → *Add as New Query*). Do **not** use *Combine* — each file is its own table. Name each query after its file.
3. **Types** (Power Query usually guesses right; check these): `date_key`, `hour_key`, `area_key`, `*_area_key` →
   Whole number; columns ending `_at`, `timestamp`, `client_timestamp` → Date/Time; `dim_date[date]`,
   `signup_date`, `joined_date`, `date_of_birth`, `week_start` → Date; `TRUE`/`FALSE` columns → True/False;
   `*_ngn`, `*_pct`, `*_km`, `*_min`, `*_sec` → Decimal/Whole number.
4. **Model view:** create the relationships above (or read them from `_relationships.csv`). Two pairs are one row to
   one row in practice — `fact_driver_offers → fact_request_notifications` and `fact_trips → fact_ride_sessions`.
   Power BI will suggest *One to one*; change Cardinality to **Many to one** and Cross filter to **Single**.
5. **Mark `dim_date` as date table** (Table tools → Mark as date table → `date`).
6. **Sort by column:** every `*_band` by its `*_band_sort`; `dim_hour[day_part]` by `day_part_sort`;
   lookup names (`session_outcome_name`, `driver_action_name`, `offer_status_name`, `traffic_level_name`, …) by `sort`;
   `dim_date[month_name]` by `month_num`; `weekday_name` by `weekday_num`; `dim_driver[age_band]` by `age_band_sort`;
   `dim_vehicle[engine_band]` by `engine_band_sort`.
7. **Hide** key columns on the fact side, all `*_sort` columns, and `metadata`.

## Starter DAX measures

```DAX
-- Requests & matching
Sessions = COUNTROWS ( fact_ride_sessions )
Searched Sessions = CALCULATE ( [Sessions], dim_session_outcome[reached_search] = TRUE () )
Matched Sessions = CALCULATE ( [Sessions], dim_session_outcome[is_matched] = TRUE () )
Match Rate = DIVIDE ( [Matched Sessions], [Searched Sessions] )
Completion Rate = DIVIDE ( CALCULATE ( [Sessions], dim_session_outcome[is_completed] = TRUE () ), [Searched Sessions] )
Median Time to Match (s) = MEDIAN ( fact_ride_sessions[time_to_match_sec] )
Median Time to First Offer (s) = MEDIAN ( fact_ride_sessions[time_to_first_offer_sec] )

-- Rider price behaviour
Riders Who Raised % =
    DIVIDE ( CALCULATE ( [Searched Sessions], fact_ride_sessions[total_price_change_pct] > 0 ), [Searched Sessions] )
Median Raise When Raised % =
    CALCULATE ( MEDIAN ( fact_ride_sessions[total_price_change_pct] ), fact_ride_sessions[total_price_change_pct] > 0 )
Price Raises = CALCULATE ( COUNTROWS ( fact_price_changes ), fact_price_changes[direction] = "increase" )
Price Drops = CALCULATE ( COUNTROWS ( fact_price_changes ), fact_price_changes[direction] = "decrease" )

-- Intents (true demand)
Intents = COUNTROWS ( fact_ride_intents )
Fulfilment Rate = DIVIDE ( CALCULATE ( [Intents], dim_intent_outcome[is_fulfilled] = TRUE () ), [Intents] )
Intents by First-Open Date =
    CALCULATE ( [Intents], USERELATIONSHIP ( fact_ride_intents[first_opened_date_key], dim_date[date_key] ) )
Median Minutes to Ride = DIVIDE ( MEDIAN ( fact_ride_intents[time_to_trip_start_sec] ), 60 )

-- Driver funnel
Pings = COUNTROWS ( fact_request_notifications )
Seen Rate = DIVIDE ( CALCULATE ( [Pings], dim_driver_action[is_seen] = TRUE () ), [Pings] )
Bids = CALCULATE ( [Pings], dim_driver_action[is_bid] = TRUE () )
Bid Rate = DIVIDE ( [Bids], [Pings] )
Decline Rate = DIVIDE ( CALCULATE ( [Pings], dim_driver_action[is_explicit_decline] = TRUE () ), [Pings] )

-- Offers & rider choice
Offers = COUNTROWS ( fact_driver_offers )
Offers Riders Acted On =
    CALCULATE ( [Offers], dim_offer_status[offer_status_key] IN { "accepted", "rejected", "expired", "closed_other_driver_chosen" } )
Offer Acceptance Rate = DIVIDE ( CALCULATE ( [Offers], dim_offer_status[is_accepted] = TRUE () ), [Offers Riders Acted On] )
Avg Offer vs Suggested % = AVERAGE ( fact_driver_offers[diff_vs_suggested_pct] )
Cheapest Offer Won % =
    DIVIDE (
        CALCULATE ( [Offers], dim_offer_status[is_accepted] = TRUE (), fact_driver_offers[was_cheapest_at_decision] = TRUE (), fact_driver_offers[live_offers_at_decision] >= 2 ),
        CALCULATE ( [Offers], dim_offer_status[is_accepted] = TRUE (), fact_driver_offers[live_offers_at_decision] >= 2 ) )

-- Trips & money
Completed Trips = CALCULATE ( COUNTROWS ( fact_trips ), fact_trips[trip_status] = "completed" )
Paid Amount = CALCULATE ( SUM ( fact_payments[payment_amount_ngn] ), fact_payments[payment_type] = "charge", fact_payments[attempt_status] = "success" )
Processor Fees = SUM ( fact_payments[processor_fee_ngn] )
Refunds = - CALCULATE ( SUM ( fact_payments[payment_amount_ngn] ), fact_payments[payment_type] = "refund" )
Booking Fees Earned = CALCULATE ( SUM ( fact_trips[booking_fee_ngn] ), fact_trips[trip_status] = "completed", fact_trips[payment_status] <> "unpaid" )
Messaging Cost = SUM ( fact_ride_sessions[messaging_cost_ngn] )
Wheelers Net = [Booking Fees Earned] + SUM ( fact_trips[commission_ngn] ) - [Processor Fees] - [Messaging Cost] - [Refunds]
Paid Amount by Method Used =    -- the method that actually took the money (fallbacks included)
    CALCULATE ( [Paid Amount],
        USERELATIONSHIP ( fact_payments[payment_method_key], dim_payment_method[payment_method_key] ),
        CROSSFILTER ( fact_ride_intents[payment_method_key], dim_payment_method[payment_method_key], NONE ) )

-- Supply & drivers' money
Online Hours = DIVIDE ( SUM ( fact_driver_shifts[online_minutes] ), 60 )
Driver Utilisation = DIVIDE ( SUM ( fact_driver_shifts[minutes_on_trips] ), SUM ( fact_driver_shifts[online_minutes] ) )
Withdrawal Fees = - CALCULATE ( SUM ( fact_driver_wallet_ledger[entry_amount_ngn] ), fact_driver_wallet_ledger[entry_type] = "withdrawal_fee" )
Cash Booking Fees Owed = - CALCULATE ( SUM ( fact_driver_wallet_ledger[entry_amount_ngn] ), fact_driver_wallet_ledger[entry_type] = "booking_fee_owed_on_cash_trip" )
Driver Wallet Balance =
    SUMX ( VALUES ( dim_driver[driver_id] ),
        CALCULATE ( LASTNONBLANKVALUE ( fact_driver_wallet_ledger[entry_id], MAX ( fact_driver_wallet_ledger[balance_after_ngn] ) ) ) )
```

Notes
- **Messaging cost belongs to the session**, including sessions that never became a trip, so `Wheelers Net` is the true
  net after WhatsApp costs on failed requests too.
- Filters on `dim_driver` reach offers through the ping (`dim_driver → fact_request_notifications → fact_driver_offers`).
  Driver state at the moment (trips today, remittance left, idle time…) is on the ping row: use those bands as
  slicers for both bid rate and offer prices.
- Payment method: the active link is the method the rider **chose** (on the intent). To slice by the method that
  actually took the money, use the pattern in `Paid Amount by Method Used` (activate the inactive link and switch the
  intent link off with `CROSSFILTER`, so there's only one path).
- Pickup vs dropoff: pickup is the active link to `dim_area`; for dropoff, wrap a measure in
  `CALCULATE ( …, USERELATIONSHIP ( fact_ride_intents[dropoff_area_key], dim_area[area_key] ) )`.

## Check figures (your model should show these with no filters)

| Measure | Value |
|---|---|
| Sessions | 4,453 |
| Searched Sessions | 4,161 |
| Match Rate | 64.6% |
| Completion Rate | 54.3% |
| Median Time to Match (s) | 63 |
| Riders Who Raised % | 39.9% |
| Median Raise When Raised % | 11.4% |
| Intents | 3,847 |
| Fulfilment Rate | 58.7% |
| Pings | 38,862 |
| Seen Rate | 84.6% |
| Bid Rate | 18.9% |
| Offer Acceptance Rate | 42.0% |
| Completed Trips | 2,258 |
| Paid Amount | ₦12,692,550 |
| Processor Fees | ₦253,073 |
| Refunds | ₦21,250 |
| Booking Fees Earned | ₦787,500 |
| Messaging Cost | ₦238,672 |
| Wheelers Net | ₦274,505 |
| Driver Utilisation | 12.9% |
| Withdrawal Fees | ₦52,400 |
| Driver Wallet Balance | ₦822,200 |

## What moved where (vs the raw v3 files)

- `driver_offers`: lost all driver profile and driver-state columns, session_id, driver_id, round, rider price, ETA,
  distance, rating, offer_type → all reachable through `notification_id` (and `dim_driver_action[offer_type]`).
- `request_notifications`: lost age, ownership, engine, join source, remittance target (→ `dim_driver`/`dim_vehicle`),
  route/areas/traffic/weather/payment/rider rating shown (→ session / intent / `dim_rider`), offer_id (offers point here).
- `ride_sessions`: lost rider, channel, class, route, pickup point, payment (→ `fact_ride_intents`), hour/weekday/holiday
  (→ `dim_hour`/`dim_date`), fare multipliers (→ `dim_ride_class`/`dim_traffic_level`/`dim_pricing_version`),
  accepted offer details and agreed fare (→ offers / trips), and stored counts (→ measures).
- `trips`: lost rider, intent, class, channel, selected payment (→ session/intent), paid amount, processor fee and
  Wheelers net (→ measures from `fact_payments`); rating tags split into `fact_trip_rating_tags`.
- `driver_shifts`: lost stored counts and utilisation (→ measures).
- Renamed for a clear field list: `attempt_status`, `ticket_status`, `ticket_category`, `payment_amount_ngn`,
  `event_amount_ngn`, `entry_amount_ngn`, `class_fare_multiplier`, `traffic_fare_multiplier`, `intent_resolved_at`.

## Regenerating

```
python3 gen_wheelers.py      # raw logs  -> wheelers_mock_data/
python3 build_powerbi.py     # model     -> wheelers_powerbi/
python3 check_powerbi.py     # 138 checks: keys, relationships, no ambiguous paths, nothing lost
```
Then *Refresh* in Power BI — table and column names stay stable.
