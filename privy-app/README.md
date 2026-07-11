# Privy Demo

Minimal Vite + React + TypeScript app showing core Privy features.

## Setup

1. Install deps:
   ```
   npm install
   ```

2. Get a Privy App ID from https://dashboard.privy.io (create an app, copy the App ID).

3. Create `.env.local` from the template and paste your App ID:
   ```
   cp .env.example .env.local
   ```
   Then edit `.env.local`:
   ```
   VITE_PRIVY_APP_ID=clxxxxxxxxxxxxxxxxxxxxx
   ```

4. Run the dev server:
   ```
   npm run dev
   ```

   Open http://localhost:5173.

## What it shows

- **Login** via email, wallet, Google, or Twitter (configured in `src/main.tsx`).
- **User profile** — Privy ID, linked accounts (email/Google/Twitter).
- **Embedded wallet** auto-created for users without one (`createOnLogin: 'users-without-wallets'`).
- **Sign message** — calls `personal_sign` via the wallet's EIP-1193 provider.
- **Link more accounts** — `linkEmail`, `linkWallet`, `linkGoogle`.
- **Logout**.

## Where things live

- `src/main.tsx` — `PrivyProvider` config (login methods, embedded wallets, theme). Reads `VITE_PRIVY_APP_ID` from env.
- `src/App.tsx` — all UI + Privy hooks (`usePrivy`, `useWallets`).
- `.env.example` — template for `VITE_PRIVY_APP_ID`.

## Allowed origins

In the Privy dashboard, add `http://localhost:5173` to your app's allowed origins or login won't work.
