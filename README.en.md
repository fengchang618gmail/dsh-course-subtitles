# dsh-course-subtitles

> Pull a video course's captions → rebuild them as whole sentences → translate line by line (EN/ZH) → generate section headings → publish one Feishu doc per lesson.

[![Awesome DSH Plugin](https://beancookie.github.io/awesome-dsh-plugin/badge.svg)](https://beancookie.github.io/awesome-dsh-plugin)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin. Once installed, just say *"run the course subtitles"* in a DSH conversation.

**Built for**: turning DeepLearning.AI / YouTube / Bilibili courses into searchable, bilingual study notes.

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

There is also a **course outline export** — one Feishu doc listing the course home page's outline, **no LLM calls, zero tokens**.

---

## Supported platforms

| Platform | URL shape | Requirements |
|---|---|---|
| **DeepLearning.AI** | `learn.deeplearning.ai/courses/...` | none — official captions, no login |
| **YouTube** | `youtube.com/watch?v=...`, `youtu.be/...`, playlists | reachable YouTube (a local proxy is auto-detected) |
| **Bilibili** | `bilibili.com/video/BV...` | the uploader must have provided a subtitle track |
| **Coursera** | `coursera.org/learn/...` | a login cookie (experimental) |

---

## Quick start

### 1. Three things you need

1. **Node.js ≥ 18** (`node -v`)
2. **A Feishu custom app** (to write the docs)
   - Create a 企业自建应用 at [open.feishu.cn/app](https://open.feishu.cn/app)
   - Grant `wiki:wiki`, `docx:document`, `drive:drive`
   - Publish a version and copy the **App ID** / **App Secret**
   - Important: open your target wiki → 设置 → 成员管理 → add the app as a member, otherwise every write fails
3. **An LLM API key** — DeepSeek (`https://api.deepseek.com`) or any OpenAI-compatible endpoint

### 2. Install

```bash
dsh plugin --profile web add github:fengchang618gmail/dsh-course-subtitles
```

Then restart DSH (exit and run `dsh --profile web` again).

### 3. Provide credentials

Set environment variables in the terminal you launch DSH from:

```bash
# macOS / Linux
export FEISHU_APP_ID=cli_xxxxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx

# Windows PowerShell
$env:FEISHU_APP_ID="cli_xxxxxxxxxxxx"
$env:FEISHU_APP_SECRET="xxxxxxxxxxxxxxxx"
$env:DEEPSEEK_API_KEY="sk-xxxxxxxxxxxx"
```

Keys are read from the environment at run time — never written into code or the repo.

### 4. Use it in a conversation

Before the first run, put the course URL and Feishu parent node into `$DSH_HOME/settings.yaml` under the `course-subtitles:` namespace:

```yaml
course-subtitles:
  courseUrl: https://learn.deeplearning.ai/courses/generative-ai-for-everyone
  feishuParent: https://your-tenant.feishu.cn/wiki/xxxxxxxxxxxx
```

Then just tell the agent:

> run the course subtitles

The agent calls these tools (normally you don't need to know their names):

| Tool | Purpose |
|---|---|
| `course_subtitles_run` | captions → translate → sections → Feishu docs; returns a run id |
| `course_outline_run` | outline export only (zero tokens) |
| `course_subtitles_status` | progress and produced doc URLs |
| `course_proxy_status` | network diagnosis: proxy reachability, yt-dlp availability |
| `course_llm_status` | lists the LLM credentials that will be tried |

---

## Credentials: nothing is hardcoded

<p align="center"><img src="docs/credentials-sketch.svg" alt="Keys come only from env vars, a local config file, or the DSH credential store — read at runtime, never committed" width="700"></p>

This project ships no API key, no tenant host and no wiki token.

Bonus: if the preferred LLM key stops working (no balance, rate limit), the engine automatically tries every other credential the machine already has.

---

## FAQ

**Feishu 403 / permission errors?** The app must be a member of the target wiki space (知识库 → 设置 → 成员管理 → add the app), and `wiki:wiki`, `docx:document`, `drive:drive` must be granted and published.

**YouTube keeps failing?** A direct connection from mainland China always fails — you need a local proxy (just leave v2rayN / Clash running; the plugin detects it automatically). Still stuck? Ask the agent to "check the network proxy" and it will show you exactly what is blocked.

**How much does a run cost?** A 32-lesson course is roughly 160k tokens (about ¥1–2 on DeepSeek). Re-runs are nearly free: captions, segmentation, translation and sections are cached on disk. The outline export costs nothing.

**Can a sentence be split across paragraphs?** No. Captions are merged into complete sentences and the body text is rebuilt programmatically from the original fragments — nothing added, nothing dropped. Section headings may only land on sentence boundaries.

---

Design notes, known limitations, CLI usage and the self-test suite: **[docs/REFERENCE.md](docs/REFERENCE.md)** (Chinese).

## License

[MIT](LICENSE)
