// Builds quick-actions-flow-definition.json: new screens + the Edit-trip and Offers screens copied verbatim.
// Run from the repo root: node scripts/gen-quick-actions-flow.mjs (npm run flow:gen:quick-actions), then push it.
//
// Completing a form (a Footer whose action is `complete`) DISABLES that message's button in the
// chat, and the rider must never get a second message to bring it back. So the server sends
// DONE ("Back to chat") only when the form has just put a new button in the chat itself — a bid
// placed sends See driver offers, a cancelled search gets a reply carrying Quick Actions. Every
// other ending — Add money, Support, "already searching", the driver's status — is a NOTE with
// no button: the rider closes it with the X and the button they tapped stays live.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = 'apps/api-gateway/src/whatsapp-flows/';
const trip = JSON.parse(readFileSync(dir + 'edit-trip-flow-definition.json', 'utf8'));
const offers = JSON.parse(readFileSync(dir + 'offers-form-flow-definition.json', 'utf8'));
const pick = (flow, id) => flow.screens.find((s) => s.id === id);

const str = (ex) => ({ type: 'string', __example__: ex });
const bool = (ex) => ({ type: 'boolean', __example__: ex });
const rows = (ex) => ({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } } }, __example__: ex });
const errorData = { error: str(''), has_error: bool(false) };
const errorLine = { type: 'TextCaption', text: '${data.error}', visible: '${data.has_error}' };
const form = (name, children, init) => ({ type: 'SingleColumnLayout', children: [{ type: 'Form', name, ...(init ? { 'init-values': init } : {}), children }] });
const footer = (label, action, payload) => ({ type: 'Footer', label, 'on-click-action': { name: 'data_exchange', payload: { action, ...payload } } });
// The payload names the form that closed; the webhook swallows it (it sends nothing).
const done = (label, rearm = 'false') => ({ type: 'Footer', label, 'on-click-action': { name: 'complete', payload: { flow: 'quick_actions', rearm } } });

const MENU = {
  id: 'MENU', title: 'Quick Actions', terminal: false,
  data: {
    greeting_line: str('Hi Timi. What would you like to do?'),
    choices: rows([
      { id: 'book', title: 'Book a ride', description: 'Type where you are going' },
      { id: 'repeat', title: 'Repeat last ride', description: 'Ikorodu Garage → Shoprite Ikeja' },
      { id: 'history', title: 'Ride history', description: 'Places you have been — book any of them again' },
      { id: 'deposit', title: 'Add money', description: 'Your account number to transfer to' },
    ]),
    ...errorData,
  },
  layout: form('menu_form', [
    { type: 'TextSubheading', text: '${data.greeting_line}' },
    errorLine,
    { type: 'RadioButtonsGroup', name: 'choice', label: 'Pick one', required: true, 'data-source': '${data.choices}' },
    footer('Continue', 'menu_choice', { choice: '${form.choice}' }),
  ]),
};

const HISTORY = {
  id: 'HISTORY', title: 'Ride history', terminal: false,
  data: {
    intro_line: str('Pick a ride to book it again — the same way, or back the other way.'),
    choices: rows([{ id: 'trip:8d1c2b6e-4f0a-4c2b-9b1e-2f9c1a7d5e10', title: '22 Sep · ₦2,400', description: 'Ikorodu Garage → Shoprite Ikeja · 1 stop' }]),
    ...errorData,
  },
  layout: form('history_form', [
    { type: 'TextBody', text: '${data.intro_line}' },
    errorLine,
    { type: 'RadioButtonsGroup', name: 'trip', label: 'Your recent rides', required: true, 'data-source': '${data.choices}' },
    footer('Continue', 'history_pick', { trip: '${form.trip}' }),
  ]),
};

const TRIP = {
  id: 'TRIP', title: 'This ride', terminal: false,
  data: {
    headline: str('This ride'),
    pickup_line: str('Pickup: Ikorodu Garage, Lagos'),
    stop_1_line: str('Stop 1: Sabo Market'), has_stop_1: bool(true),
    stop_2_line: str(''), has_stop_2: bool(false),
    stop_3_line: str(''), has_stop_3: bool(false),
    destination_line: str('Destination: Shoprite Ikeja'),
    fare_line: str("You paid ₦2,400 — today's fare is worked out when you pick"),
    ride_id: str('8d1c2b6e-4f0a-4c2b-9b1e-2f9c1a7d5e10'),
    directions: rows([
      { id: 'repeat', title: 'Repeat this ride', description: 'Ikorodu Garage → Shoprite Ikeja' },
      { id: 'reverse', title: 'Reverse this ride', description: 'Shoprite Ikeja → Ikorodu Garage' },
    ]),
    ...errorData,
  },
  layout: form('trip_form', [
    { type: 'TextHeading', text: '${data.headline}' },
    { type: 'TextBody', text: '${data.pickup_line}' },
    { type: 'TextBody', text: '${data.stop_1_line}', visible: '${data.has_stop_1}' },
    { type: 'TextBody', text: '${data.stop_2_line}', visible: '${data.has_stop_2}' },
    { type: 'TextBody', text: '${data.stop_3_line}', visible: '${data.has_stop_3}' },
    { type: 'TextBody', text: '${data.destination_line}' },
    { type: 'TextCaption', text: '${data.fare_line}' },
    errorLine,
    { type: 'RadioButtonsGroup', name: 'direction', label: 'Book it', required: true, 'data-source': '${data.directions}' },
    footer('Continue', 'trip_direction', { ride_id: '${data.ride_id}', direction: '${form.direction}' }),
  ]),
};

const STATUS = {
  id: 'STATUS', title: 'Your current trip', terminal: false,
  data: {
    headline: str('Looking for drivers'),
    line_1: str('Ikorodu Garage → Shoprite Ikeja'),
    line_2: str('Your price: ₦2,500'),
    line_3: str(''), has_line_3: bool(false),
    note: str('No offers yet. Drivers near you are seeing your request now. Tap below to check for offers.'),
    cta_label: str('Check for offers'),
  },
  layout: form('status_form', [
    { type: 'TextHeading', text: '${data.headline}' },
    { type: 'TextBody', text: '${data.line_1}' },
    { type: 'TextBody', text: '${data.line_2}' },
    { type: 'TextBody', text: '${data.line_3}', visible: '${data.has_line_3}' },
    { type: 'TextCaption', text: '${data.note}' },
    footer('${data.cta_label}', 'status_next', {}),
  ]),
};

const ADD_MONEY = {
  id: 'ADD_MONEY', title: 'Add money', terminal: false,
  data: {
    headline: str('Add money to your wallet'),
    balance_line: str('Wallet: ₦1,200'),
    bank_line: str('Bank: Wema Bank'),
    account_number: str('8012345678'),
    account_label: str('Account number'),
    name_line: str('Name: Wheelers / Timi Olowu'),
    note_line: str('Transfer from any bank app to this account. It lands in your wallet by itself.'),
  },
  layout: form('add_money_form', [
    { type: 'TextHeading', text: '${data.headline}' },
    { type: 'TextBody', text: '${data.balance_line}' },
    { type: 'TextBody', text: '${data.bank_line}' },
    // A box, not a line, so the number can be long-pressed and copied. v5.1 prefills through the Form's init-values.
    { type: 'TextInput', name: 'account_number', label: '${data.account_label}', 'input-type': 'text', required: false, 'helper-text': 'Long-press the number to copy it' },
    { type: 'TextBody', text: '${data.name_line}' },
    { type: 'TextCaption', text: '${data.note_line}' },
  ], { account_number: '${data.account_number}' }),
};

const SUPPORT = {
  id: 'SUPPORT', title: 'Support', terminal: false,
  data: {
    headline: str('Wheelers support'),
    contact_line: str('+234 800 000 0000'),
    note_line: str('A person will reply as soon as they can.'),
  },
  layout: form('support_form', [
    { type: 'TextHeading', text: '${data.headline}' },
    { type: 'TextSubheading', text: '${data.contact_line}' },
    { type: 'TextBody', text: '${data.note_line}' },
  ]),
};

// ── Book a ride, as screens: where to → the places found → your trip (+ stops) → review → price ──
const textBox = (name, label, required, helper) => ({ type: 'TextInput', name, label, 'input-type': 'text', required, ...(helper ? { 'helper-text': helper } : {}) });
const radio = (name, label, source, show) => ({ type: 'RadioButtonsGroup', name, label, required: false, 'data-source': `\${data.${source}}`, visible: `\${data.${show}}` });

const BOOK_WHERE = {
  id: 'BOOK_WHERE', title: 'Book a ride', terminal: false,
  data: { pickup: str(''), destination: str(''), ...errorData },
  layout: form('book_where_form', [
    { type: 'TextBody', text: 'Where are you, and where are you going? A name is enough — you pick the exact place next.' },
    errorLine,
    textBox('pickup', 'Pickup', true, 'e.g. Ikeja City Mall'),
    textBox('destination', 'Destination', true, 'e.g. Unilag gate, Yaba'),
    footer('Find places', 'where_to', { pickup: '${form.pickup}', destination: '${form.destination}' }),
  ], { pickup: '${data.pickup}', destination: '${data.destination}' }),
};

const BOOK_PLACES = {
  id: 'BOOK_PLACES', title: 'Which places?', terminal: false,
  data: {
    pickup_options: rows([{ id: '0', title: 'Ikeja City Mall', description: 'Obafemi Awolowo Way, Ikeja, Lagos' }]),
    show_pickup: bool(true),
    destination_options: rows([{ id: '0', title: 'University of Lagos', description: 'Akoka, Yaba, Lagos' }]),
    show_destination: bool(true),
    ...errorData,
  },
  layout: form('book_places_form', [
    { type: 'TextBody', text: 'Here is what I found. Pick the right places.' },
    errorLine,
    radio('pick_pickup', 'Pickup', 'pickup_options', 'show_pickup'),
    radio('pick_destination', 'Destination', 'destination_options', 'show_destination'),
    footer('Continue', 'book_places', { pick_pickup: '${form.pick_pickup}', pick_destination: '${form.pick_destination}' }),
  ]),
};

const BOOK_TRIP = {
  id: 'BOOK_TRIP', title: 'Your trip', terminal: false,
  data: {
    pickup_line: str('Pickup: Ikeja City Mall, Obafemi Awolowo Way, Ikeja'),
    destination_line: str('Destination: University of Lagos, Akoka, Yaba'),
    summary_line: str('12.4 km · ~38 min · suggested fare ₦5,200'),
    stop_1: str(''), stop_2: str(''), stop_3: str(''),
    ...errorData,
  },
  layout: form('book_trip_form', [
    { type: 'TextHeading', text: '${data.pickup_line}' },
    { type: 'TextBody', text: '${data.destination_line}' },
    { type: 'TextCaption', text: '${data.summary_line}' },
    { type: 'TextBody', text: 'Stops on the way? Up to three, optional. Then Confirm trip to name your price.' },
    errorLine,
    textBox('stop_1', 'Stop 1 (optional)', false),
    textBox('stop_2', 'Stop 2 (optional)', false),
    textBox('stop_3', 'Stop 3 (optional)', false),
    footer('Confirm trip', 'book_trip', { stop_1: '${form.stop_1}', stop_2: '${form.stop_2}', stop_3: '${form.stop_3}' }),
  ], { stop_1: '${data.stop_1}', stop_2: '${data.stop_2}', stop_3: '${data.stop_3}' }),
};

const BOOK_STOP_PLACES = {
  id: 'BOOK_STOP_PLACES', title: 'Which stops?', terminal: false,
  data: {
    stop_1_options: rows([{ id: '0', title: 'Sabo Market', description: 'Herbert Macaulay Way, Yaba' }]), show_stop_1: bool(true),
    stop_2_options: rows([{ id: 'none', title: 'None of these', description: 'Type it again with the area' }]), show_stop_2: bool(false),
    stop_3_options: rows([{ id: 'none', title: 'None of these', description: 'Type it again with the area' }]), show_stop_3: bool(false),
    ...errorData,
  },
  layout: form('book_stop_places_form', [
    { type: 'TextBody', text: 'More than one place matched a stop. Pick the right one.' },
    errorLine,
    radio('pick_stop_1', 'Stop 1', 'stop_1_options', 'show_stop_1'),
    radio('pick_stop_2', 'Stop 2', 'stop_2_options', 'show_stop_2'),
    radio('pick_stop_3', 'Stop 3', 'stop_3_options', 'show_stop_3'),
    footer('Continue', 'book_stop_places', { pick_stop_1: '${form.pick_stop_1}', pick_stop_2: '${form.pick_stop_2}', pick_stop_3: '${form.pick_stop_3}' }),
  ]),
};

const BOOK_REVIEW = {
  id: 'BOOK_REVIEW', title: 'Your trip', terminal: false,
  data: {
    pickup_line: str('Pickup: Ikeja City Mall'),
    stop_1_line: str('Stop 1: Sabo Market'), has_stop_1: bool(true),
    stop_2_line: str(''), has_stop_2: bool(false),
    stop_3_line: str(''), has_stop_3: bool(false),
    destination_line: str('Destination: University of Lagos'),
    summary_line: str('13.1 km · ~41 min · suggested fare ₦5,500'),
    ...errorData,
  },
  layout: form('book_review_form', [
    { type: 'TextBody', text: '${data.pickup_line}' },
    { type: 'TextBody', text: '${data.stop_1_line}', visible: '${data.has_stop_1}' },
    { type: 'TextBody', text: '${data.stop_2_line}', visible: '${data.has_stop_2}' },
    { type: 'TextBody', text: '${data.stop_3_line}', visible: '${data.has_stop_3}' },
    { type: 'TextBody', text: '${data.destination_line}' },
    { type: 'TextCaption', text: '${data.summary_line}' },
    errorLine,
    footer('Confirm trip', 'confirm_trip', {}),
  ]),
};

// Something to read, then close with the X (WhatsApp's own). Not terminal, no Footer: the button in the chat lives on.
const NOTE = {
  id: 'NOTE', title: 'Wheelers', terminal: false,
  data: { headline: str('Already searching'), note: str('Your search is still on. Tap See driver offers in the chat to watch it.') },
  layout: form('note_form', [
    { type: 'TextHeading', text: '${data.headline}' },
    { type: 'TextBody', text: '${data.note}' },
  ]),
};

const DONE = {
  id: 'DONE', title: 'Wheelers', terminal: true,
  data: { headline: str('You have successfully bid ₦2,500'), note: str('Drivers see your price now.'), rearm: str('true') },
  layout: form('done_form', [
    { type: 'TextHeading', text: '${data.headline}' },
    { type: 'TextBody', text: '${data.note}' },
    done('Back to chat', '${data.rearm}'),
  ]),
};

const flow = {
  version: '5.1',
  data_api_version: '3.0',
  // Forward-only: every target sits later in this order (Meta refuses anything else).
  routing_model: {
    // Meta allows 10 routes out of a screen. MENU never reaches DONE (the server answers NOTE instead), so it is not listed here.
    MENU: ['BOOK_WHERE', 'HISTORY', 'TRIP', 'REVIEW_TRIP', 'SET_PRICE', 'STATUS', 'OFFERS', 'ADD_MONEY', 'SUPPORT', 'NOTE'],
    BOOK_WHERE: ['BOOK_PLACES', 'NOTE', 'DONE'],
    BOOK_PLACES: ['BOOK_TRIP', 'NOTE', 'DONE'],
    BOOK_TRIP: ['BOOK_STOP_PLACES', 'BOOK_REVIEW', 'SET_PRICE', 'NOTE', 'DONE'],
    BOOK_STOP_PLACES: ['BOOK_REVIEW', 'NOTE', 'DONE'],
    BOOK_REVIEW: ['SET_PRICE', 'NOTE', 'DONE'],
    HISTORY: ['TRIP', 'NOTE', 'DONE'],
    TRIP: ['REVIEW_TRIP', 'NOTE', 'DONE'],
    REVIEW_TRIP: ['SET_PRICE', 'NOTE', 'DONE'],
    SET_PRICE: ['NOTE', 'DONE'],
    STATUS: ['OFFERS', 'NOTE', 'DONE'],
    OFFERS: ['CHANGE_PRICE', 'CANCEL_SEARCH', 'NOTE', 'DONE'],
    CHANGE_PRICE: ['NOTE', 'DONE'],
    CANCEL_SEARCH: ['NOTE', 'DONE'],
    ADD_MONEY: [],
    SUPPORT: [],
    NOTE: [],
    DONE: [],
  },
  screens: [
    MENU, BOOK_WHERE, BOOK_PLACES, BOOK_TRIP, BOOK_STOP_PLACES, BOOK_REVIEW, HISTORY, TRIP,
    pick(trip, 'REVIEW_TRIP'), pick(trip, 'SET_PRICE'),
    STATUS,
    pick(offers, 'OFFERS'), pick(offers, 'CHANGE_PRICE'), pick(offers, 'CANCEL_SEARCH'),
    ADD_MONEY, SUPPORT,
    NOTE, DONE,
  ],
};
for (const s of flow.screens) if (!s) throw new Error('a copied screen is missing');
writeFileSync(dir + 'quick-actions-flow-definition.json', JSON.stringify(flow, null, 2) + '\n');
console.log('screens', flow.screens.map((s) => s.id).join(' '));
