# ChatGPT Extension Setup

## Why This Exists

The original Playwright-launched ChatGPT login flow is unreliable against Cloudflare and Chrome automation protections. The supported live path is now:

- use your normal logged-in Chrome session for ChatGPT
- use the local Chrome extension as the bridge
- keep Playwright only for non-ChatGPT browser tools

## One-Time Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Build the project:

   ```sh
   npm run build
   ```

3. Open Chrome extensions:

   ```text
   chrome://extensions
   ```

4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select:

   ```text
   /Users/reznichenkoandrii/htdocs/marshal/dist/chrome-extension
   ```

7. Open [chatgpt.com](https://chatgpt.com) in your normal Chrome profile and confirm you are already logged in.

## Login Handshake

Run:

```sh
./login-chatgpt.sh
```

Expected behavior:

- the local bridge server starts on `http://127.0.0.1:3210`
- the extension polls the server from your ChatGPT tab
- the CLI waits until the extension connects

If the CLI keeps waiting:

- confirm the extension is enabled
- refresh the ChatGPT tab
- keep the ChatGPT tab focused long enough for the first bridge handshake

## Running The Agent

After the extension has connected at least once, run:

```sh
./run-agent.sh "your task"
```

Defaults:

- `CHATGPT_BRIDGE_MODE=extension`
- bridge port: `3210`

Optional `.env` example:

```sh
CHATGPT_BRIDGE_MODE=extension
CHATGPT_EXTENSION_BRIDGE_PORT=3210
```

If you change `CHATGPT_EXTENSION_BRIDGE_PORT`, rebuild before reloading the unpacked extension so the compiled background script uses the same port:

```sh
npm run build
```

## Notes

- This flow uses your real trusted Chrome session, not a Playwright-controlled login browser.
- The legacy Playwright ChatGPT bridge still exists behind `CHATGPT_BRIDGE_MODE=playwright`, but it is not the recommended live path.
