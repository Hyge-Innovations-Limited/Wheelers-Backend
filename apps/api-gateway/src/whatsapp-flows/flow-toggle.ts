/**
 * Master switch for Meta WhatsApp Flows — the tappable "Book now" and
 * "View offers" buttons.
 *
 * OFF means the bot is chat-only: greetings get a normal reply, and driver
 * bids arrive as the numbered chat list riders reply to with "1", "pay",
 * "cancel". The flow endpoint, screens and published Meta flows all stay in
 * place; nothing sends a button while this is false, whatever WHATSAPP_FLOW_ID
 * and WHATSAPP_OFFERS_FLOW_ID happen to hold.
 *
 * To bring the form back: flip this to true, make sure both flow ids are set
 * in .env, and redeploy.
 */
export const META_FLOWS_ENABLED = false;

/**
 * The ONE flow that is on: the "Edit trip" form (pickup, up to three stops and
 * the destination on one screen — see edit-trip-flow.ts). It has its own switch
 * because it replaces five chat messages with one form and touches no money,
 * while the booking and offers flows above stay off.
 *
 * It also needs WHATSAPP_EDIT_TRIP_FLOW_ID in .env (written there by
 * `npm run flow:push:edit-trip`). Without the id, or with this false, "Edit
 * trip" opens the chat's Choose sheet exactly as before.
 */
export const EDIT_TRIP_FLOW_ENABLED = true;
