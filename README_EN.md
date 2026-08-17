# dsh-deepseek-vision-bridge

> Eyes for text-only agents — bridges chat.deepseek.com's (unofficial) vision mode into DeepSeek Harness (DSH).

DSH sessions often run on text-only models, while chat.deepseek.com ships a real multimodal image-understanding mode in beta. This plugin wraps the site's full vision pipeline (reverse-engineered: proof-of-work → image upload → fork to the vision model → streaming completion) as DSH capabilities:

- **🔧 `deepseek_vision` model tool** — pass image paths or URLs, get back a structured textual description (scene / verbatim text transcription / key data & errors / inferred context), so a text-only model can answer questions about images in the same turn
- **🖼️ In-chat images** — paste or drop images straight into the DSH composer; the plugin transcribes them before the step enters the model. The durable log keeps the original image; the transcription carries the DSH attachment-store path for follow-ups
- **📱 Settings-page login** — WeChat QR (headless long-poll, the same flow the site uses) / email-or-mobile + password / paste a userToken. The token persists through the official credentials service in `~/.dsh/.credentials.yaml` and survives DSH restarts
- **🧹 Delete-after-use** — every temporary web session is deleted in a `finally` block (success / failure / timeout alike), so your web session list stays clean

## Install

Install straight from GitHub (not on npm for now):

```bash
dsh plugin --profile web add KannaKuron/dsh-deepseek-vision-bridge
# or the full URL
dsh plugin --profile web add https://github.com/KannaKuron/dsh-deepseek-vision-bridge
```

Then **hard-refresh the browser** (Cmd/Ctrl+Shift+R). A DSH restart is only needed for host-half updates; client changes hot-reload.

> Updating: re-run the same install command (it pulls the repo's latest master).

<details>
<summary><b>When pnpm blocks the install (supply-chain cooldown / build-script gate)</b></summary>

First-time GitHub installs pass through two pnpm protections, each needing a one-time allow:

1. **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** (unrelated to this project): other plugins already in your profile published versions within the last 24h. Add the packages it lists to `~/.dsh/profiles/web/pnpm-workspace.yaml`:
   ```yaml
   minimumReleaseAgeExclude:
     - dsh-better-sidebar
     - dshmarket
     # …other packages from the error
   ```
2. **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`** (this project builds on install): add the exact key from the error to the same file:
   ```yaml
   allowBuilds:
     'dsh-deepseek-vision-bridge@git+https://github.com/KannaKuron/dsh-deepseek-vision-bridge.git': true
   ```

Re-run the install command after both edits. Subsequent installs won't trigger either gate.

</details>

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
