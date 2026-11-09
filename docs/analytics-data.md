# Wheelers analytics data: where riders stop

Six datasets answer one question from every side: **at what point did a rider stop taking the ride, and why?** They are database views, so they are always current.

## Getting the data

**1. Download (easiest).** Admin → **Data** → choose the dates → **Download CSV** next to a dataset. The files are UTF-8 with a byte-order mark (Excel shows ₦ correctly), comma-separated, one header row, at most 300,000 rows per download (choose a shorter period for more). Power BI: *Get data → Text/CSV*. Python: `pd.read_csv(path, parse_dates=[...])`.

**2. Power BI connected to the database (refreshes itself).** The database only listens on the server, so connect through an SSH tunnel with a read-only login that can see only these views. Once, on the server (choose a strong password; never commit it):

```sql
CREATE ROLE analytics_ro LOGIN PASSWORD 'choose-a-strong-one';
GRANT CONNECT ON DATABASE wheelers TO analytics_ro;
GRANT USAGE ON SCHEMA public TO analytics_ro;
GRANT SELECT ON ride_funnel, ride_page_sessions, ride_page_events, ride_bids, rider_events, price_quotes TO analytics_ro;
ALTER ROLE analytics_ro SET statement_timeout = '60s';
```

Then on the analyst's computer: `ssh -N -L 5433:127.0.0.1:5432 <user>@<server>`, and in Power BI *Get data → PostgreSQL*, server `localhost:5433`, database `wheelers`, user `analytics_ro`. Use **Import** mode with a daily refresh, not DirectQuery: it keeps load off the live database. Python: `sqlalchemy.create_engine("postgresql://analytics_ro:…@localhost:5433/wheelers")`.

Times are UTC (`…_at`). Columns named `…_day`, `day`, `…_hour`, `hour` are already in Lagos time.

## The funnels

**Every ride (any channel), `ride_funnel.stage_reached`:**
`1_searching → 2_offers_received → 3_driver_assigned → 4_driver_arrived → 5_trip_started → 6_completed`. A ride that did not finish has `stopped_at_stage` and `cancel_reason`.

**WhatsApp page, `ride_page_sessions.furthest_step`:**
`0_opened → 1_saw_price → 2_searched → 3_got_offers → 4_tapped_accept → 5_driver_confirmed`. `outcome` is `booked`, `cancelled`, `went_back_to_edit` or `left`; `last_event` is the very last thing they did.

**Before any ride, `rider_events`:** a rider shown a price is `ride_quoted` (WhatsApp, `source = whatsapp`) or `ride_estimate_requested` (app, `source = app`); confirming a WhatsApp trip is `ride_trip_confirmed`; then `ride_search_started`. Quoted riders with no ride after are the ones who looked at the price and left.

Join keys: `rider_id`/`user_id` (a person), `ride_id`, `session_id` (one page visit), `driver_id`.

## Datasets

### ride_funnel: one row per ride
| column | meaning |
|---|---|
| ride_id, trip_number | the ride (trip_number is the WH-00216 number) |
| rider_id, driver_id | who |
| channel | APP, WHATSAPP, MCP, UNKNOWN |
| pickup_zone, dest_zone | launch zone, or empty outside them |
| distance_km, planned_minutes | the planned trip |
| pricing_version | 1, 2 or 3 (how fees were split) |
| suggested_fare_ngn, rider_offer_ngn, agreed_fare_ngn, final_fare_ngn | the price at each point |
| payment_method | WALLET, XLM… |
| offers, drivers_offering, lowest_offer_ngn, highest_offer_ngn | driver offers on it |
| status | the ride's status now |
| outcome | completed, cancelled, no_driver (nobody took it in time), replaced_by_new_request (the rider searched again, or stopped the search on the WhatsApp page to change the trip: not a loss), disputed, open |
| stage_reached (1–6), furthest_stage | how far it got |
| stopped_at_stage | for cancelled or disputed rides: where it stopped |
| cancel_stage | BEFORE_MATCH, AFTER_MATCH, DRIVER_EN_ROUTE, ACTIVE_TRIP |
| cancel_reason | the reason given (riders pick from a list; "Other: …" is their words) |
| requested_at, first_offer_at, driver_assigned_at, driver_arrived_at, trip_started_at, completed_at, cancelled_at | when each stage happened (UTC) |
| minutes_to_first_offer, minutes_to_driver_assigned, minutes_driver_to_pickup, minutes_waiting_at_pickup, minutes_in_trip, minutes_until_cancelled | the gaps |
| requested_day, requested_hour, requested_weekday | Lagos time |

### ride_page_sessions: one row per visit to the WhatsApp ride page
| column | meaning |
|---|---|
| session_id, user_id, ride_id | the visit, the rider, the ride it was for (last one) |
| started_at, last_event_at, seconds_on_page, events | how long and how much |
| saw_price, price_changes, opened_trip_edit, changed_trip | before searching |
| tapped_find_drivers, find_failures, searched | the search |
| got_offers, most_offers_seen, minutes_to_first_offer | offers |
| raises_tapped, price_updates, offers_declined, declined_all | while searching |
| tapped_accept, minutes_offer_to_accept, wallet_was_short | choosing a driver; wallet_was_short = asked to add money |
| driver_confirmed | booked on this visit (the page moved to the confirmed screen; opening the link again during a trip does not count) |
| went_back_to_edit | stopped the search to change the trip |
| opened_cancel, cancelled, cancel_reason, cancel_detail | cancelling and why |
| last_event, last_phase | the last thing they did, and on which screen |
| furthest_step, outcome | see the funnel above |
| day, hour | Lagos time |

### ride_page_events: every step on the page
`event_id, session_id, user_id, ride_id, step` (1, 2, 3… within the visit), `event, phase` (price, offers, confirmed, idle), `props` (JSON details), `client_at` (the phone's clock), `recorded_at`, `day`.

Events: `page_opened, phase_shown, page_hidden, page_visible, page_left` (props: secondsOnPage), `price_changed` (method: plus, minus, typed; amountNgn), `find_tapped` (amountNgn, suggestedNgn, minNgn), `find_failed` (code), `trip_edit_opened, place_searched` (field, letters, results), `place_picked, stop_removed, trip_saved` (distanceKm, suggestedNgn), `trip_save_failed, offer_received` (count, lowestNgn), `raise_tapped` (by), `price_sheet_opened` (from), `price_updated` (fromNgn, toNgn), `price_update_failed, offer_declined` (priceNgn, rank), `decline_all` (count), `accept_tapped` (priceNgn, rank, offers), `accept_failed` (code), `pay_method_chosen` (method), `wallet_short_shown` (shortNgn), `account_copied, pay_sheet_closed, cancel_opened, cancel_reason_picked` (reason), `cancel_confirmed` (reason, detail), `cancel_failed, cancel_kept, edit_trip_back_tapped, edit_trip_back_confirmed, edit_trip_back_kept, chat_link_tapped, call_driver_tapped, chat_driver_tapped, map_recentred`.

### ride_bids: every driver offer
`bid_id, ride_id, driver_id, rider_id, amount_ngn, rider_offer_ngn, ratio_to_rider_offer` (1.10 = 10% over the rider's price), `eta_seconds, distance_km_to_pickup, status, offered_at, resolved_at, minutes_after_request, day`.

### rider_events: other things people did
`event_id, user_id, event, source, ride_id, metadata` (JSON), `occurred_at, day, hour`. Useful events: `ride_quoted, ride_trip_confirmed, ride_estimate_requested` (metadata: distanceKm, suggestedFareNgn, minOfferNgn, stops, pickupZone), `ride_search_started, ride_offer_accepted, ride_search_cancelled` (metadata: reason), `ride_trip_changed, ride_offers_declined, auth_signup, auth_login, referral_code_applied`.

### price_quotes: every price shown (the price side; no person)
`quote_id, quoted_at, pickup_zone, distance_km, planned_minutes, suggested_fare_ngn, min_offer_ngn, market_fare_ngn` (the other app's figure), `floor_fare_ngn, set_by, rush, day_period, hour_factor, surge_factor, demand_factor, traffic_ratio, day, hour`.

## Starter questions
- Drop-off by stage and channel: count `ride_funnel` by `furthest_stage, channel`.
- Why searches end: `ride_funnel` where outcome in (cancelled, no_driver), by `stopped_at_stage, cancel_reason`.
- Price shown vs taken: `rider_events` quotes per rider, left join `ride_funnel` on rider and day.
- What riders did last before leaving the page: `ride_page_sessions` where outcome = left, by `furthest_step, last_event`.
- Do raises work: `ride_page_sessions.raises_tapped > 0` against `driver_confirmed`.
- Offer pricing: `ride_bids.ratio_to_rider_offer` by hour and zone.
