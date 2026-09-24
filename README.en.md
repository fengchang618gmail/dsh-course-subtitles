# dsh-course-subtitles

> Pull a video course's captions → rebuild them as whole sentences → translate line by line (EN/ZH) → generate section headings → publish one Feishu doc per lesson.

[![Awesome DSH Plugin](https://beancookie.github.io/awesome-dsh-plugin/badge.svg)](https://beancookie.github.io/awesome-dsh-plugin)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that also works standalone as a CLI.

**Built for**: turning DeepLearning.AI / YouTube / Bilibili courses into searchable, bilingual study notes; feeding a personal knowledge base; and dissecting how a popular video is structured.

---

## What it does

<p align="center"><img src="docs/pipeline-sketch.svg" alt="Pipeline: course URL → fetch captions → whole sentences → EN/ZH translation → section headings → Feishu docs" width="780"></p>

The output is one Feishu doc per lesson:

```
# 01 Welcome 欢迎                        ← lesson title (auto-translated)
Week 1 · 4:32 · 2026-01-01               ← metadata

## What is Generative AI? 什么是生成式AI？  ← generated section heading (EN + ZH)

Generative AI is a general purpose technology.   ← original sentence
生成式 AI 是一种通用技术。                          ← Chinese translation
```

There is also a **course outline export**: it reads the course home page's outline, keeps only the video entries, groups them by week/module and writes **one** Feishu doc — **no LLM calls, zero tokens**.

---

## Supported platforms

| Platform | URL shape | Requirements |
|---|---|---|
| **DeepLearning.AI** | `learn.deeplearning.ai/courses/...`, `www.deeplearning.ai/courses/...` | none — official captions, no login |
| **YouTube** | `youtube.com/watch?v=...`, `youtu.be/...`, playlists | reachable YouTube (a local proxy is auto-detected; `yt-dlp` fallback included) |
| **Bilibili** | `bilibili.com/video/BV...` | the uploader must have provided a subtitle track |
| **Coursera** | `coursera.org/learn/...` | a login cookie (experimental) |

---

## Quick start

### 0. Three things you need

1. **Node.js ≥ 18**
2. **A Feishu custom app** (to write the docs)
   - Create a 企业自建应用 at [open.feishu.cn/app](https://open.feishu.cn/app)
   - Grant `wiki:wiki`, `docx:document`, `drive:drive`
   - Publish a version and copy the **App ID** / **App Secret**
   - Important: open your target wiki → 设置 → 成员管理 → add the app as a member, otherwise every write fails
3. **An LLM API key** — DeepSeek (`https://api.deepseek.com`) or any OpenAI-compatible endpoint

### 1. Install

```bash
dsh plugin --profile web add github:fengchang618gmail/dsh-course-subtitles
```

Then restart DSH (exit and run `dsh --profile web` again).

> This is the official DSH plugin channel: one command installs the package into the
> profile and auto-registers it in `dsh.profile.bundles` (the `dsh.bundle` manifest +
> `cordis.patch.yml` inside the package do the wiring) — no clone, no extra scripts.
> Once the package is published to npm the command shortens to
> `dsh plugin --profile web add dsh-course-subtitles`.

### 2. Provide credentials (never stored in the repo)

**Environment variables**

```bash
export FEISHU_APP_ID=cli_xxxxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx
```

**Or the DSH credential store** — `$DSH_HOME/.credentials.yaml`:

```yaml
version: 1
refs:
  FEISHU_APP_ID: cli_xxxxxxxxxxxx
  FEISHU_APP_SECRET: xxxxxxxxxxxxxxxx
  DEEPSEEK_API_KEY: sk-xxxxxxxxxxxx
```

### 3. Run

Dry run first (no Feishu writes):

```bash
node bin/cs.js run --course https://learn.deeplearning.ai/courses/generative-ai-for-everyone --dry-run --lessons 1
```

Then publish:

```bash
node bin/cs.js run \
  --course https://learn.deeplearning.ai/courses/generative-ai-for-everyone \
  --parent https://your-tenant.feishu.cn/wiki/xxxxxxxxxxxxxxxxxxxx
```

Outline only (free):

```bash
node bin/cs.js outline --course https://www.deeplearning.ai/courses/agentic-ai --parent <your-wiki-node>
```

---

## Two ways to use it

### Inside DSH

After installing and restarting, say *"run the course subtitles"* and the agent calls:

| Tool | Purpose |
|---|---|
| `course_subtitles_run` | captions → translate → sections → Feishu docs; returns a run id |
| `course_outline_run` | outline export only (zero tokens) |
| `course_subtitles_status` | progress and produced doc URLs |
| `course_proxy_status` | network diagnosis: proxy reachability, yt-dlp availability |
| `course_llm_status` | lists the LLM credentials that will be tried; `probe: true` pings each |

### CLI

```bash
course-subtitles run [options]      # subtitle pipeline (one Feishu doc per lesson)
course-subtitles outline [options]  # course outline (one Feishu doc, zero tokens)
course-subtitles adapters           # list supported platforms
course-subtitles proxy              # proxy / yt-dlp diagnosis
course-subtitles llm [--probe]      # show and test the LLM credential chain
course-subtitles config             # print the resolved config (secrets masked)
```

---

## Credentials: nothing is hardcoded

<p align="center"><img src="docs/credentials-sketch.svg" alt="Keys come only from env vars, a local config file, or the DSH credential store — read at runtime, never committed" width="700"></p>

This project ships no API key, no tenant host and no wiki token. Credentials are resolved from, in order:

1. **Environment variables** — `LLM_API_KEY` / `DEEPSEEK_API_KEY` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `COURSERA_COOKIE`
2. **A local config file** (`.gitignore`d)
3. **The DSH credential store** — `$DSH_HOME/.credentials.yaml`

### Automatic LLM key fallback

If the preferred key stops working (no balance, rate limit, region block), the engine automatically tries every other credential the machine already has:

```bash
$ course-subtitles llm --probe
  1. deepseek     deepseek-chat        OK 799ms
  2. qimingxing   deepseek-v4.1-flash  OK 2660ms
  3. glm          glm-5.3              OK 952ms
  4. kimi         kimi-k3              OK 8099ms
  ...
```

Each candidate carries its own base URL, model and wire protocol (`openai-completions`, `openai-responses`, `anthropic-messages`), so a relay key is never sent to the official domain. Declare extra providers in the config:

```json
"llmProviders": [
  { "name": "my-relay", "baseUrl": "https://relay.example.com/v1",
    "model": "deepseek-chat", "api": "openai-completions", "apiKeyEnv": "MY_RELAY_API_KEY" }
]
```

---

## FAQ

**Feishu 403 / permission errors?** The app must be a member of the target wiki space (知识库 → 设置 → 成员管理 → add the app), and `wiki:wiki`, `docx:document`, `drive:drive` must be granted and published.

**YouTube keeps failing?** Run `course-subtitles proxy` first — it reports whether a proxy exists, whether it actually carries traffic, and whether `yt-dlp` is installed.

**How much does a run cost?** A 32-lesson course is roughly 160k tokens (about ¥1–2 on DeepSeek). Re-runs are nearly free: captions, segmentation, translation and sections are cached on disk. The outline export costs nothing.

**Can a sentence be split across paragraphs?** No. Captions are merged into complete sentences and the body text is rebuilt programmatically from the original fragments — nothing added, nothing dropped. Section headings may only land on sentence boundaries.

**Code changes not taking effect?** The host plugin loads at DSH startup — restart DSH after editing `src/`. The CLI picks changes up immediately.

---

## More

Full design notes, known limitations and the self-test suite: **[docs/REFERENCE.md](docs/REFERENCE.md)** (Chinese).

## License

[MIT](LICENSE)
