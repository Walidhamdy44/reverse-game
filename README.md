# Reverse Words

A two-player word game for iPhone and Safari. One player records a secret word. The next player hears it backwards, imitates the sound, then hears their own imitation backwards and guesses the original.

The game never asks for an account. Recording, reversal, and playback happen on the device. Recordings are cleared when a round is cleared.

## During development

Run `npm install`, then `npm start` for iPhone or `npm run web` for Safari/browser testing. The development server must stay running while testing. Safari microphone access requires HTTPS in production (localhost is also allowed for local testing).

## Install the Safari version

Open [reverse-words.expo.app](https://reverse-words.expo.app) in Safari on iPhone, then use Share → Add to Home Screen to keep it as an app icon. Let the page finish loading while online so its app files can be cached. After that, it can record and play without a network connection. The game does not need a login.

To publish a later update, run `npm run build:web` and `npx eas-cli@latest deploy --prod`.

Safari stores offline website data in a cache that iOS can remove when it needs space. This makes the Safari version useful offline, but it cannot promise the same permanent offline storage as a native app installed from the App Store.

## Install a standalone iPhone app

The `preview` EAS profile creates an internal iPhone build with the app bundle included. Build it with `npx eas-cli@latest build --platform ios --profile preview`. Download and install the build while online; after installation, the game does not need Metro, localhost, or internet to play.

Internal iPhone installation needs an active Apple Developer Program membership and the iPhone registered to that account. A `production` build can be submitted to TestFlight or the App Store instead. No account is required inside the game.

## What to expect

- English or Arabic controls and instructions, with an instant language switch.
- A five-second maximum for each recording, with no automatic speech recognition.
- Original audio and reversed audio stay inside the current round on the phone.
- The iPhone app records local PCM audio; the Safari version records with the browser's available audio format and converts it locally for reversal.
- Safari asks for microphone permission when you first record. Use an HTTPS address and allow microphone access for the site.
- The app shows a setup error if a recording is interrupted or cannot be read.

## Project notes

See [DESIGN.md](./DESIGN.md) for the visual direction and Impeccable principles used.
