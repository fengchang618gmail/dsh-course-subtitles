# dsh-course-subtitles

> 把视频课程的字幕抓下来 → 重排成完整句子 → 逐句中英对照翻译 → 自动分章节 → 一课一篇写进飞书文档。

[![Awesome DSH Plugin](https://beancookie.github.io/awesome-dsh-plugin/badge.svg)](https://beancookie.github.io/awesome-dsh-plugin)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件，也可以完全脱离 DSH 当命令行工具用。

**适合谁用**：想把 DeepLearning.AI / YouTube / B 站上的课程变成**可检索、可搜索、带中英对照的学习笔记**的人；在做个人知识库的人；需要批量拆解爆款视频结构的知识工作者。

---

## 它到底做了什么

```
课程链接 ──► 抓字幕 ──► 合并成完整句子 ──► 逐句中英翻译 ──► 生成章节标题 ──► 飞书文档（每课一篇）
             (4 个平台)   (绝不切断一句话)      (LLM)          (H2 中英)        └─ 自动挂到你的知识库目录下
```

最终你得到一篇飞书文档，长这样：

```
# 01 Welcome 欢迎                          ← 课程标题（自动中文翻译）
第 1 周 · 视频时长 4:32 · 生成时间 2026-01-01   ← 元信息

## What is Generative AI? 什么是生成式AI？   ← 自动生成的章节标题（中英对照）

Generative AI is a general purpose technology.   ← 英文原句
生成式 AI 是一种通用技术。                          ← 中文翻译

...
```

另外还有一个**课程大纲导出**功能：把课程首页的目录（只保留视频条目）抓成一篇飞书文档，按 Week / Module 分块 —— **不调用任何模型，零 token 花费**。

---

## 支持哪些平台

| 平台 | 链接形式 | 需要什么 |
|---|---|---|
| **DeepLearning.AI** | `learn.deeplearning.ai/courses/...`、`www.deeplearning.ai/courses/...` | 无需登录，官方字幕 |
| **YouTube** | `youtube.com/watch?v=...`、`youtu.be/...`、播放列表 | 能访问 YouTube（国内需要代理；插件会自动探测本机代理，也支持 yt-dlp 兜底） |
| **Bilibili** | `bilibili.com/video/BV...` | UP 主上传过字幕轨（AI 字幕也算） |
| **Coursera** | `coursera.org/learn/...` | 需要登录 Cookie（实验性支持） |

---

## 5 分钟上手

### 第 0 步：准备三样东西

1. **Node.js ≥ 18**（`node -v` 检查）
2. **一个飞书自建应用**（用来写文档）
   - 去 [飞书开放平台](https://open.feishu.cn/app) 创建「企业自建应用」
   - 在「权限管理」里开通：`wiki:wiki`、`docx:document`、`drive:drive`
   - 发布版本，拿到 **App ID** 和 **App Secret**
   - ⚠️ 关键一步：打开你要写入的**知识库 → 设置 → 成员管理 → 添加应用**，把这个应用加进去，否则会报权限错误
3. **一个 LLM API Key**：DeepSeek 官方（`https://api.deepseek.com`）或任何 OpenAI 兼容服务都行

> 如果你在国外或者能直连 YouTube，第 2 步做完就能跑。国内访问 YouTube 需要本地代理（v2rayN / Clash 等），插件会自动识别，不用配。

### 第 1 步：安装

**方式 A：装成 DSH 插件（推荐，能在对话里直接用）**

```bash
git clone https://github.com/fengchang618gmail/dsh-course-subtitles.git
cd dsh-course-subtitles
node scripts/activate.js      # 把插件链接进 DSH profile 并写好 cordis.patch.yml
# 然后重启 DSH（退出后重新运行 dsh --profile web）
```

**方式 B：只用命令行，不装插件**

```bash
git clone https://github.com/fengchang618gmail/dsh-course-subtitles.git
cd dsh-course-subtitles
node bin/cs.js --help
```

### 第 2 步：配置密钥（二选一，都不写进代码）

**方式一：环境变量**（最简单）

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

**方式二：DSH 凭据库**（装成插件的推荐做法，密钥不进 shell 历史）

编辑 `$DSH_HOME/.credentials.yaml`（Windows 是 `C:\Users\你的用户名\.dsh\.credentials.yaml`）：

```yaml
version: 1
refs:
  FEISHU_APP_ID: cli_xxxxxxxxxxxx
  FEISHU_APP_SECRET: xxxxxxxxxxxxxxxx
  DEEPSEEK_API_KEY: sk-xxxxxxxxxxxx
```

### 第 3 步：跑起来

先做个**不写飞书的演练**，确认抓取和翻译都正常：

```bash
node bin/cs.js run --course https://learn.deeplearning.ai/courses/generative-ai-for-everyone --dry-run --lessons 1
```

没问题了，正式写入飞书（`--parent` 换成你自己的知识库节点链接）：

```bash
node bin/cs.js run \
  --course https://learn.deeplearning.ai/courses/generative-ai-for-everyone \
  --parent https://your-tenant.feishu.cn/wiki/xxxxxxxxxxxxxxxxxxxx
```

只导出大纲（不花钱）：

```bash
node bin/cs.js outline --course https://www.deeplearning.ai/courses/agentic-ai --parent <你的知识库节点链接>
```

---

## 两种用法

### 用法一：在 DSH 对话里直接用

装好插件并重启 DSH 后，把课程地址和飞书目录写进设置（`$DSH_HOME/settings.yaml` 的 `course-subtitles:` 段），之后只要对 agent 说一句：

> 帮我跑一下课程字幕

agent 会调用这几个工具：

| 工具 | 作用 |
|---|---|
| `course_subtitles_run` | 抓字幕 → 翻译 → 分章节 → 写飞书，返回 run id |
| `course_outline_run` | 只导出课程大纲（零 token） |
| `course_subtitles_status` | 查看运行进度和产出文档链接 |
| `course_proxy_status` | 网络自检：本机代理能不能出网、yt-dlp 在不在 |
| `course_llm_status` | 列出会依次尝试的 LLM 凭据，`probe: true` 可以逐个试通 |

### 用法二：命令行

```bash
course-subtitles run [options]      # 字幕流水线（每课一篇飞书文档）
course-subtitles outline [options]  # 课程大纲（一篇飞书文档，零 token）
course-subtitles adapters           # 看看支持哪些平台
course-subtitles proxy              # 本机代理 / yt-dlp 体检
course-subtitles llm [--probe]      # 看看会用哪些 LLM 密钥，并逐个试通
course-subtitles config             # 打印最终生效的配置（密钥打码）
```

常用参数：

```bash
--lessons 1-10,12    # 只跑部分课时
--dry-run            # 只抓取+翻译，不写飞书
--force              # 全部重算，并原地重建已存在的飞书文档（链接不变）
--update-doc         # 只用缓存重写文档内容，不重新下载/翻译
--no-group           # 不按 Week/Module 分组，全部平铺
--no-segment         # 不合并断句，按原始字幕片段输出
--proxy <url>        # 手动指定代理：http://127.0.0.1:10809 或 socks5://127.0.0.1:10808
--proxy-mode off     # 完全不用代理
--no-yt-dlp          # 关闭 yt-dlp 兜底
--json               # 输出机器可读报告
```

---

## 配置项

配置文件放在工作目录下叫 `course-subtitles.config.json`（可参考 `config.example.json`），可用 `--config <path>` 指定。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `courseUrl` | 示例课程 | 课程 / 视频链接 |
| `courseDisplayName` | — | 写进文档里的课程名 |
| `feishuParent` | 必填 | 飞书知识库父节点链接或 token |
| `feishuDomain` | 自动推导 | 拼 wiki 链接用的域名，留空则从 `feishuParent` 推导 |
| `groupByWeek` | `true` | 按 Week / Module 建目录 |
| `llmBaseUrl` / `llmModel` | DeepSeek | 首选 LLM 接口与模型 |
| `llmProviders` | `[]` | 额外要尝试的服务商（见下） |
| `llmConcurrency` | `3` | 翻译并发数 |
| `translateChunkSize` | `60` | 每批翻译多少句 |
| `segmentSentences` | `true` | 是否把字幕片段合并成完整句子 |
| `proxyUrl` / `proxyMode` | 自动 | 代理设置，`auto` = 直连优先、失败才走代理 |
| `ytDlpPath` / `youtubeYtDlp` | 自动 | YouTube 字幕兜底 |
| `courseraCookie` | 空 | 只有 Coursera 需要 |

---

## 关于密钥：仓库里没有任何密钥

这个项目**不包含、不需要、也不接受**硬编码的 API Key。所有凭据都从下面三个地方按优先级读取：

1. **环境变量**：`LLM_API_KEY` / `DEEPSEEK_API_KEY` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `COURSERA_COOKIE`
2. **配置文件**（你自己的本地文件，已被 `.gitignore` 排除）
3. **DSH 凭据库** `$DSH_HOME/.credentials.yaml`

### LLM 多密钥自动回退

如果首选的 key 挂了（余额不足、被限流、区域不通），插件会**自动依次尝试本机已有的其它凭据**，不用你手动切换：

```bash
$ course-subtitles llm
chain (7 candidates, tried in order):
  1. deepseek     deepseek-chat        https://api.deepseek.com              [openai-completions, key from credentials.yaml]
  2. qimingxing   deepseek-v4.1-flash  https://api.aisj.ai                   [openai-responses,   key from credentials.yaml]
  3. glm          glm-5.3              https://api.aisj.ai                   [openai-completions, key from credentials.yaml]
  ...
```

加 `--probe` 会真的逐个 ping 一遍，直接告诉你哪个可用：

```bash
$ course-subtitles llm --probe
  1. deepseek     deepseek-chat        OK 944ms
  2. qimingxing   deepseek-v4.1-flash  OK 2472ms
  3. kimi         kimi-k3              OK 9986ms
```

要用别的服务商，在配置里声明即可：

```json
"llmProviders": [
  { "name": "my-relay", "baseUrl": "https://relay.example.com/v1",
    "model": "deepseek-chat", "api": "openai-completions", "apiKeyEnv": "MY_RELAY_API_KEY" }
]
```

`api` 支持三种协议：`openai-completions`（默认）、`openai-responses`、`anthropic-messages`。

---

## 常见问题

**Q：报飞书权限错误 / 403？**
这个应用必须被加进目标知识库：知识库 → 设置 → 成员管理 → 添加应用。同时确认已开通 `wiki:wiki`、`docx:document`、`drive:drive` 权限并发布了版本。

**Q：YouTube 一直失败？**
先跑 `course-subtitles proxy`。它会告诉你：本机有没有代理、代理能不能真的出网、yt-dlp 装没装。国内直连 YouTube 一定失败，需要有本地代理。

**Q：跑一遍要花多少钱？**
一个 32 课的课程大约 16 万 token，DeepSeek 上约 ¥1–2。重跑不会重复花钱 —— 字幕、断句、翻译、章节都做了磁盘缓存，只补缺失的部分。**大纲导出完全不花钱。**

**Q：会不会把一句话从中间切断？**
不会。字幕片段会先合并成完整句子，段落始终由原始片段程序化拼接，不增字、不删字；章节标题也只允许落在句子边界上，落不进就前移到下一句。

**Q：改完代码不生效？**
host 插件是 DSH 启动时加载的，改完 `src/` 要**重启 DSH**；CLI 则立即生效。

---

## 项目结构

```
src/engine/          # 纯 Node 引擎（与 DSH 解耦，CLI 直接复用）
  adapters/          #   deeplearning | youtube | bilibili | coursera
  llm.js             #   凭据链：环境变量 / 配置文件 / DSH 凭据库，逐个尝试
  segment.js         #   整句分段（绝不切断一句话）
  translate.js       #   批量翻译（分批 / 对齐 / 重试 / 补缺）
  sections.js        #   章节标题生成 + 位置校验
  outline.js         #   课程大纲解析
  feishu.js          #   飞书文档创建 / 写入 / 挂载 / 幂等
  proxy.js           #   代理自动识别 + yt-dlp 定位
  pipeline.js        #   编排 + 缓存断点续跑
src/host/index.js    # DSH Host 半（cordis 插件 + HTTP 路由 + agent 工具）
bin/cs.js            # CLI 入口
```

更详细的设计说明、已知限制和自测脚本，见 **[docs/REFERENCE.md](docs/REFERENCE.md)**。

---

## 许可

[MIT](LICENSE)
