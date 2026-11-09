# Wheelers sandbox

A full local Wheelers stack for end-to-end testing. Real-money (Paystack), email
and storage integrations are stubbed or inert; WhatsApp/Twilio are never
reached by the app-rider flow. State lives in its own database
(`wheelers_sandbox`) and Redis db 1 — it never touches production or your
normal local data.

```
npm run sandbox            # infra + migrations + gateway/ride/wallet services
npm run sandbox:seed       # sandbox_rider + sandbox_driver (approved, funded)
npm run sandbox:e2e        # scripted booking Opebi → Surulere, 12 assertions
npm run sandbox:driver     # live actor: auto-bids and drives every request
npm run sandbox:rider      # live actor: books once and rides to completion
```

Mix and match with the mobile apps (Wheelersapp repo):

```
npm run start:driver:sandbox    # Expo dev server pointed at this backend
npm run start:rider:sandbox
```

Sign in with `sandbox_driver` / `sandbox123` (or `sandbox_rider`). In a
simulator, use Settings → Developer → **Mock location** to pin the device to
Lagos — device simulators default to Cupertino and will never match otherwise.

Typical bug-hunt: `npm run sandbox:driver` in one terminal, the rider **app**
in a simulator — or the rider sim against the driver **app** — and reproduce
the exact flow that failed in production, with every service log in front of
you.
