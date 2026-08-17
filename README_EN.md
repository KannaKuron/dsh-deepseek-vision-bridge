# dsh-deepseek-vision-bridge

> Eyes for text-only agents — bridges chat.deepseek.com's (unofficial) vision mode into DeepSeek Harness (DSH).

DSH sessions often run on text-only models, while chat.deepseek.com ships a real multimodal image-understanding mode in beta. This plugin wraps the site's full vision pipeline (reverse-engineered: proof-of-work → image upload → fork to the vision model → streaming completion) as DSH capabilities:

- **🔧 `deepseek_vision` model tool** — pass image paths or URLs, get back a structured textual description (scene / verbatim text transcription / key data & errors / inferred context), so a text-only model can answer questions about images in the same turn
- **🖼️ In-chat images** — paste or drop images straight into the DSH composer; the plugin transcribes them before the step enters the model. The durable log keeps the original image; the transcription carries the DSH attachment-store path for follow-ups
- **📱 Settings-page login** — WeChat QR (headless long-poll, the same flow the site uses) / email-or-mobile + password / paste a userToken. The token persists through the official credentials service in `~/.dsh/.credentials.yaml` and survives DSH restarts
- **🧹 Delete-after-use** — every temporary web session is deleted in a `finally` block (success / failure / timeout alike), so your web session list stays clean

## Install

```bash
dsh plugin --profile web add dsh-deepseek-vision-bridge@latest
```

Then **hard-refresh the browser** (Cmd/Ctrl+Shift+R). A DSH restart is only needed for host-half updates; client changes hot-reload.

## Usage

1. Open **Settings → DeepSeek 视觉** and log in (WeChat QR recommended)
2. Send an image directly in the composer, or hand the model an image path to use with `deepseek_vision`
3. The settings page has a built-in vision test button

## How it works

Every operation spawns a plain-Node worker (`src/worker.mjs`) that speaks the reverse-engineered protocol: the official PoW wasm (embedded, ~26 KB, zero deps) for `x-ds-pow-response`, `upload_file` → `fork_file_task` (to the vision model) → `chat_session/create` → streaming `chat/completion` with `model_type: "vision"` → `chat_session/delete`. Login goes through WeChat's open-platform QR + the site's server-side code exchange + `oauth/get_token`; the token persists via the official DSH `credentials` service (ref `DSV_USER_TOKEN`). In-chat images are transcribed by the official `agent/pre-step` waterfall (the durable log is untouched), with an `llm/stream` last-resort net that placeholders image blocks still heading to a genuinely text-only model.

## ⚠️ Disclaimer

- This plugin talks to **unofficial, reverse-engineered web endpoints** of chat.deepseek.com — not a public API. Breakage may follow site changes; use at your own risk and in line with DeepSeek's ToS.
- Usage and risk-control on your DeepSeek account is your own account's business.

## Build from source

```bash
git clone https://github.com/KannaKuron/dsh-deepseek-vision-bridge.git
cd dsh-deepseek-vision-bridge
npm install
npm run build
npm test
```

## License

[MIT](./LICENSE)
