# ChatGPT Extension Setup

## Why This Exists

The original Playwright-launched ChatGPT login flow is unreliable against Cloudflare and Chrome automation protections. The supported live path is now:

- use your normal logged-in Chrome profile for ChatGPT
- use the local Chrome extension as the bridge
- keep Playwright only for non-ChatGPT browser tools

The primary profile for this repository is now `Andrii`, so ChatGPT history and projects stay in the same real Chrome user context.

## One-Time Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Build the project:

   ```sh
   npm run build
   ```

The normal launcher will load the unpacked extension automatically from:

```text
/Users/reznichenkoandrii/htdocs/marshal/dist/chrome-extension
```

You only need manual `chrome://extensions` setup if Chrome blocks command-line extension loading on your machine.

## Daily Launch Flow

Run:

```sh
./start-marshal.sh
```

Expected behavior:

- the script resolves the Chrome profile named `Andrii`
- Chrome starts in that real profile
- the unpacked extension is loaded automatically
- `chatgpt.com` opens in that same profile
- the local bridge server starts on `http://127.0.0.1:3210`
- the extension polls the server from your ChatGPT tab
- the CLI waits until the extension connects

If the CLI keeps waiting:

- confirm Chrome opened in the `Andrii` profile
- confirm the extension was loaded
- refresh the ChatGPT tab
- keep the ChatGPT tab focused long enough for the first bridge handshake

If the Marshal-managed `Andrii` Chrome session is already running, the launcher will reuse it and open ChatGPT there again.

If another Chrome session is already using the same Chrome app and user-data directory, the launcher will stop instead of quitting the whole app. This avoids closing unrelated Chrome profiles.

The old global auto-quit behavior is intentionally disabled for safety. `CHATGPT_AUTO_QUIT_CHROME=1` no longer force-quits all of Chrome:

```sh
CHATGPT_AUTO_QUIT_CHROME=1
```

## Running The Agent

After the extension has connected at least once, run:

```sh
./run-agent.sh "your task"
```

Defaults:

- `CHATGPT_BRIDGE_MODE=extension`
- bridge port: `3210`
- Chrome profile name: `Andrii`

Optional `.env` example:

```sh
CHATGPT_BRIDGE_MODE=extension
CHATGPT_EXTENSION_BRIDGE_PORT=3210
CHATGPT_CHROME_PROFILE_NAME=Andrii
```

If you change `CHATGPT_EXTENSION_BRIDGE_PORT`, rebuild before reloading the unpacked extension so the compiled background script uses the same port:

```sh
npm run build
```

## Notes

- This flow uses your real trusted Chrome session, not a Playwright-controlled login browser.
- The launcher targets the Chrome profile stored as `Default`, whose visible name is `Andrii`.
- The legacy Playwright ChatGPT bridge still exists behind `CHATGPT_BRIDGE_MODE=playwright`, but it is not the recommended live path.
