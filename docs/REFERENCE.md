# dsh-course-subtitles · 详细参考

面向开发和运维的完整说明。想快速上手请看 [README.md](../README.md)。

DSH 双半插件（Host + Client）：把视频课程的字幕提取、逐行英中对照翻译、章节标题生成、飞书文档发布做成一条可复用的流水线；另含 **Course Outline 导出**（课程首页大纲 → 一页飞书文档，只留 video 的标题纯文本，保留 week/module 分块）。

```
课程 URL ──► 适配器 ──► 字幕 ──► 智能断句 ──► 批量翻译(EN/ZH) ──► 章节标题(H2 英中) ──► 每课一个飞书文档
                  (片段)      (合并为完整句子)                     │                      └─ 挂到指定父文档下（可按 week/module 分组）
                                                                   └─ 磁盘缓存 + 断点续跑（重跑零 token）

课程首页 Course Outline ──► 解析(条目类型/文本/超链接/分块) ──► 只留 video ──► 保留 week/module(+小节)
                                                                              └─► 一页飞书文档（bullet 纯文本，默认不含超链接）
```

## 功能

- **两条流水线**：
  | 模式 | 输入 | 输出 | 用 LLM |
  |---|---|---|---|
  | `run`（字幕） | 课程 URL | 每课一个飞书文档（英中逐句 + H2 章节） | 是（断句 + 翻译 + 章节） |
  | `outline`（大纲） | 课程首页 Course Outline | **一个**飞书文档：video 的标题（纯文本，无超链接），按 week/module 分块 | 否（零 token） |
- **4 个平台适配器**（按 URL 自动选择）：
  | 适配器 | 匹配 | 说明 |
  |---|---|---|
  | `deeplearning` | learn.deeplearning.ai/courses/… 或 www.deeplearning.ai/courses/… | 官方字幕，免登录；两种 URL 都支持字幕与大纲导出 |
  | `youtube` | youtube.com / youtu.be | 公开字幕（innertube），单视频或播放列表 |
  | `bilibili` | bilibili.com/video | 多 P 视频，需要 UP 主上传过字幕轨 |
  | `coursera` | coursera.org/learn | 需要登录 Cookie（`courseraCookie`），实验性 |
- **凭据全部来自环境，仓库零密钥**：`llmApiKey` / `feishuAppSecret` / `feishuAppId` / `courseraCookie` 按 **环境变量 → 配置文件 → `$DSH_HOME/.credentials.yaml`** 的顺序解析，代码里没有任何默认密钥、租户域名或 wiki token。
- **LLM 多凭据回退链**（`src/engine/llm.js`）：首选配置的 key，失败后自动依次尝试本机已有的其它凭据（每个候选自带 baseUrl / model / 协议，所以中转 key 不会被发到官方域名）。`course-subtitles llm --probe` 可以逐个试通。支持 `openai-completions`、`openai-responses`、`anthropic-messages` 三种协议；中转站把未加 `/v1` 的路径返回 HTML（HTTP 200）的情况已做归一化处理。
- **网络与代理（自动识别，不写死地址）**：直连被阻断或触发 YouTube 的 "confirm you're not a bot" 时，引擎按顺序解析代理 —— `proxyUrl`（设置/CLI 显式指定）→ `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` → **Windows 系统代理（WinINET，即 v2rayN / Clash 打开“系统代理”时写入的值）** → 探测本机常见本地代理端口（v2rayN `10809`/`10808`、Clash `7890`/`7891`/`7897`、sing-box `2080`…）。每个候选都必须真的完成一次 `CONNECT` 或 SOCKS5 握手（对目标主机）才会被采用；端口探测先做并行 TCP 检查，因此机器上没有代理时只多花约 0.4s。
  - `proxyMode`：`auto`（默认，**直连优先、失败才走代理**，所以能直连的飞书/DeepSeek 请求完全不受影响）| `always`（全部走代理）| `off`（禁用代理）；
  - `proxyBypass`（或 `NO_PROXY`）：逗号分隔的直连主机，支持 `localhost`、`.feishu.cn`、`*`；
  - `proxyProbePorts`：自定义探测端口列表（默认用内置的常见端口）；
  - HTTP 代理与 SOCKS5 都支持（含用户名/密码），https 通过 CONNECT 隧道承载。
- **YouTube yt-dlp 回退**：WEB 客户端被机器人验证挡住时（innertube `LOGIN_REQUIRED/UNPLAYABLE`、watch 页没有 `captionTracks`、timedtext 返回空 body），适配器会自动调用本机 `yt-dlp`（它会轮换 player client）取回官方字幕轨。yt-dlp 的定位同样不写死：`ytDlpPath` → PATH → winget / scoop / chocolatey / Python Scripts 等标准安装位置 → `python -m yt_dlp`；`youtubeYtDlp: false` 可关闭。单视频的标题还额外通过不受机器人验证影响的 oEmbed 接口获取，保证缓存复用后文档标题依然正确。
- **代理自检**：`course-subtitles proxy`（CLI）、`course_proxy_status`（agent 工具）或 `GET /api/course-subtitles/proxy` 会报告系统代理、环境变量、每个候选端口的可用性/失败原因、最终选中的代理以及 yt-dlp 状态。
- **Course Outline 导出**：
  - 从课程首页 `Course Outline` 区块解析每个条目的**类型**（Video / Reading / Code Example / Graded・Quiz…）、**文本**与**超链接**，默认只保留 `video`（`--types` 可改，`--types all` 全留）；
  - 保留 **week / module 分块**（`Week 1: …`、`Module 3: Tool use`）；页面若有 subtopic 小节，再加一层 H3，小节内条目归到对应小节（`--no-subtopics` 只留 week/module，条目上浮）；
  - 非条目链接（如 "Download the syllabus"）不会混入；**写进文档的条目是纯文本** —— 链接只留在 `--json` 报告里，文档中不含任何超链接 run（需要可点击标题就加 `--outline-links`，或配置 `outlineLinks: true`，此时按飞书要求做 URL encode）；
  - 首页大纲有时只渲染一部分（小节折叠处由前端补渲染，实测 generative-ai-for-everyone 首页只渲染出 1/33 条），此时自动改用平台课程树（`learn.deeplearning.ai` 的 lessons/subtopics/listing）补齐，并在文档与事件里写出提示；`--source homepage|learn|auto` 可强制来源；
  - 幂等：同名文档已存在则跳过，`--force` / `--update-doc` **原地重建**（链接不变），重复运行不产生多余节点。
- **整句分段（绝不在一句话中间断段）**：字幕片段常是半句话（如 `the scores assigned by humans as data, w`）。断句分两步：先按标点 + 缩写规则把片段切成「原子」，再把原子合并成**完整句子** —— 一个自然段 = 一整句话；正文始终由原始片段程序化拼接，不丢字、不改字。有标点的字幕（DeepLearning.AI 等）完全由程序判定，**不再调用 LLM**（省 token、结果稳定）；只有无标点的自动字幕（YouTube ASR）才让 LLM 分组，且模型给出的分组会被吸附到句子边界并强制补齐（段落停在半句上就并入下一段）。小标题（H2）只能插在句子边界，绝不会出现在一句话中间。`--no-segment` 可退回按片段输出。
- **逐句翻译**：英文一句 + 中文一句，经凭据回退链批量翻译。
- **章节标题**：每课自动生成 3-10 个英中对照 H2 小标题，插到对应句子前；位置会被校验，落在句子中间的标题自动前移到下一句开头（无处可放则丢弃，而不是切开句子）。
- **乱码防护**：全链路文本消毒（剔除孤立代理对、控制字符、U+FFFD 替换符，保留合法 emoji），飞书写入前再兜底一次 —— 文档中不会出现 `���`。
- **飞书输出**：每课一个 docx，H1 标题 + 元信息 + H2 章节 + 英中句子行；挂到指定 wiki 父节点下；可选**按 week/module 分组**（自动建 `Week 1: …` / `Module 1: …` 目录）；幂等（已存在跳过）；`--force` 全部重算并**原地重建**已存在的文档，`--update-doc` 只按缓存重写文档内容 —— 两者都保留原链接（只有在原地重建失败时才回退到「新建 + 删除旧文档」）。
- **省 token**：字幕只取一次并缓存；有标点的字幕断句完全不调 LLM（零 token），无标点的自动字幕才输出一次索引（极小输出）；翻译按 60 句/包批量 + JSON 对齐 + 并发 3 路 + 退避重试 + 缺句自动补译；章节标题只喂英文一遍出双语；重跑/断点续跑只补缺失部分。一个 32 课课程全程约 16 万 token（DeepSeek 约 ¥1-2）。大纲导出不调用任何模型。

## 用法

### CLI（独立运行，不依赖 DSH GUI）

```bash
# 预览（只下载字幕+翻译+标题，不写飞书）
node bin/cs.js run --course <url> --dry-run --lessons 1

# 完整运行（写飞书）
node bin/cs.js run --course <url> --parent <wiki链接或token>

# 已发布过的课程：改版后原地刷新已有文档内容（同一个链接，不产生副本）
node bin/cs.js run --course <url> --update-doc

# Course Outline：课程首页大纲 → 一页飞书文档（只留 video，保留 week/module，纯文本无链接）
node bin/cs.js outline --course https://www.deeplearning.ai/courses/agentic-ai --parent <wiki链接或token>
node bin/cs.js outline --course <url> --dry-run            # 只看解析结果，不写飞书
node bin/cs.js outline --course <url> --json               # 机器可读报告（含每个视频的文本+链接）
node bin/cs.js outline --course <url> --types all          # 不筛选类型
node bin/cs.js outline --course <url> --no-subtopics       # 去掉 subtopic 层
node bin/cs.js outline --course <url> --outline-links      # 恢复可点击的标题超链接
node bin/cs.js outline --course <url> --source homepage    # 强制只用首页大纲
node bin/cs.js outline --course <url> --update-doc         # 原地刷新已存在的大纲文档（链接不变）

# 常用参数
--config <path>    # JSON 配置文件
--proxy <url>      # 指定代理（http://127.0.0.1:10809 或 socks5://127.0.0.1:10808）；
                   # 不指定则自动识别：环境变量 → Windows 系统代理 → 探测本机常见端口
--proxy-mode auto|always|off   # auto=直连优先、失败才走代理（默认）；off=完全不用代理
--no-proxy         # 等同 --proxy-mode off
--yt-dlp <path>    # 指定 yt-dlp 可执行文件（默认自动探测）；--no-yt-dlp 关闭回退
--lessons 1-10,12  # 只处理部分课时（run 模式）
--force            # 全部重算（字幕/断句/翻译/标题）并原地重建已存在的飞书文档
--update-doc       # 只按缓存重写已存在的飞书文档内容（不重新下载/翻译，链接不变）
--no-group         # 关闭按 week/module 分组
--skip-translate | --skip-sections | --skip-feishu | --dry-run
--json             # 输出机器可读报告

# 网络自检：本机有哪些代理、能否真的出网、yt-dlp 是否就绪
node bin/cs.js proxy
node bin/cs.js proxy --json
node bin/cs.js proxy --target www.youtube.com:443

# LLM 凭据自检：会依次尝试哪些 key，以及每个 key 是否真的通
node bin/cs.js llm
node bin/cs.js llm --probe
```

配置解析顺序：内置默认 < 配置文件 < 环境变量 < CLI 参数。
密钥解析顺序：环境变量（`LLM_API_KEY` / `DEEPSEEK_API_KEY` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `COURSERA_COOKIE`）→ 配置文件 → `$DSH_HOME/.credentials.yaml`；大纲模式不需要任何 LLM key。

### DSH 插件（GUI 内调用）

```bash
node scripts/activate.js    # 1) 注册进 DSH profile（符号链接 + cordis.patch.yml 行）
# 2) 重启 DSH：退出当前 dsh 进程后重新运行  dsh --profile web
# 3) 在对话中直接说“运行课程字幕”或“导出课程大纲”，agent 会调用对应工具
#    （用存储的配置直接跑，无需再填课程 URL / 飞书父文档）
```

- **没有 GUI 配置页面**：插件通过五个 agent 工具调用，全部使用已存储的配置：
  - `course_subtitles_run` —— 启动字幕流水线（所有参数都是可选覆盖项，缺省用存储配置），返回 run id；
  - `course_outline_run` —— 导出课程大纲：只留指定类型（默认 video）的标题**纯文本**（默认不含超链接，`outlineLinks: true` 可恢复可点击链接），保留 week/module 分块，写**一个**飞书文档；
  - `course_subtitles_status` —— 查询两类运行的进度与结果（含大纲文档链接、本次实际使用的代理）；
  - `course_proxy_status` —— 网络诊断：报告自动识别到的代理、各候选端口是否真的能出网、系统代理值与 yt-dlp 状态（只读，YouTube 等平台跑不通时先看它）；
  - `course_llm_status` —— LLM 凭据诊断：按顺序列出会用到的凭据（不含密钥本身），`probe: true` 时逐个 ping（只读，出现 "all LLM credentials failed" 时先看它）。
- 配置存储遵循 DSH 规范：
  - **非密钥配置**（课程 URL、飞书父文档、分组名、周目录、模型参数、大纲类型、代理与 yt-dlp 相关开关等）写入设置文档 `$DSH_HOME/settings.yaml` 的 `course-subtitles:` 命名空间（`proxyUrl` / `proxyMode` / `proxyBypass` / `proxyProbePorts` / `ytDlpPath` / `youtubeYtDlp`，全部留空即为自动识别）；
  - **密钥**（`feishuAppId`/`feishuAppSecret`/`llmApiKey`/`courseraCookie`）统一存在 `$DSH_HOME/.credentials.yaml` 的 refs 中（`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `DEEPSEEK_API_KEY` / `COURSERA_COOKIE`）；
  - **额外 LLM 服务商**通过 `llmProviders` 声明（数组，见 `config.example.json`），key 用 `apiKeyEnv` 指向环境变量名，不写进配置文档。
- Host 半同时提供同源 HTTP 接口：`/api/course-subtitles/{run,outline,status,config,adapters,proxy}`（`run` / `outline` 同样使用存储配置，body 可为空；`outline` 不需要 LLM key；`proxy` 支持 `?target=host:port`）。
- ⚠️ host 插件代码在 DSH 启动时载入：改完 `src/` 需要**重启 DSH**（`dsh --profile web`）才会在 GUI 里生效，CLI 则立即生效。

## 项目结构

```
src/engine/          # 纯 Node 引擎（与 DSH 解耦，CLI 直接复用）
  adapters/          #   deeplearning | youtube | bilibili | coursera
  llm.js             #   凭据链：环境变量 / 配置文件 / DSH 凭据库，逐个尝试
  outline.js         #   Course Outline 解析/筛选/报告/文档块（video 文本 + 超链接 + 分块）
  html.js            #   零依赖 HTML 小工具（实体解码、文本提取、区块定位）
  segment.js         #   整句分段（原子切分 + 合并成完整句子；无标点时才问 LLM）
  translate.js       #   批量翻译（chunk/对齐/重试/补缺）
  sections.js        #   章节标题生成 + 标题位置校验（只喂英文，双语输出）
  feishu.js          #   文档创建/块写入/wiki 挂载/超链接 run/按 week·module 分组/幂等
  proxy.js           #   代理自动识别（config→env→WinINET→端口探测）+ CONNECT/SOCKS5 隧道 + yt-dlp 定位
  pipeline.js        #   编排 + 缓存断点（runPipeline / runOutlinePipeline）
  config.js, cache.js, http.js, text.js
src/host/index.js    # DSH Host 半（cordis 插件 + HTTP 路由 + agent 工具 + 配置存储）
bin/cs.js            # CLI 入口（run / outline / adapters / proxy / llm / config）
scripts/             # 自测脚本 + activate.js（DSH 注册）
```

## 自测

```bash
node scripts/verify_segments.js                           # 断句/段落完整性用例（41 项断言）
node scripts/verify_segments.js --cache <cacheDir>        # 回放已缓存的真实字幕轨，逐课检查“无半句段落”
node scripts/verify_outline.js                            # 大纲解析离线用例（62 项断言，含纯文本/超链接两种模式）
node scripts/verify_outline.js --live <courseUrl>         # 额外解析真实课程首页（打印每个视频的文本+链接）
node scripts/verify_proxy.js                              # 代理层离线用例（35 项断言：解析/绕过/候选顺序/握手字节/yt-dlp 参数）
node scripts/verify_proxy.js --live                       # 额外探测本机真实代理状态（不依赖任何写死的地址）
node scripts/verify_bundle.js   # host 导入（需要能解析 DSH 运行时包；否则输出 SKIPPED）
node scripts/host_test.js       # host 路由（config/status/run/outline）端到端（同样需要 DSH 运行时包）
node scripts/test_segment.js    # 真实课程第 1 课断句（打印策略 + 半句段落数）
node bin/cs.js proxy            # 本机代理/yt-dlp 体检
node bin/cs.js llm --probe      # 逐个 ping 本机可用的 LLM 凭据
node bin/cs.js run --course <url> --dry-run --lessons 1   # 引擎冒烟
```

## 已知限制

- 无标点的自动字幕（YouTube ASR 等）本身没有句读信息，只能靠 LLM 分组，此时无法用标点校验位置；插件在这种情况下只做「不额外制造断裂」的合并，不会硬切句子（但源字幕的半句只能用整段呈现）。
- 断句策略升级后缓存键同步升级（`discover:…:v4`、`segments:…:v2`、`bilingual/sections:…:seg2`），旧的对应缓存不会被复用：下次运行会重新断句并重译一次（旧缓存文件留在 `.course-subtitles-cache` 里，可自行删除）。
- **大纲导出目前只支持 `deeplearning` 适配器**（learn/www.deeplearning.ai）；其它适配器调用 `outline` 会给出明确报错。
- 首页 `Course Outline` 中折叠的小节列表由前端渲染，服务端 HTML 可能只含一部分条目；本插件用平台课程树校验，缺失时自动补齐并把提示写进文档首部。
- 大纲文档默认**不含超链接**（条目就是纯文本）；只有 `--outline-links` / `outlineLinks: true` 才会写入链接，此时 URL 按飞书 docx 规范做 encode（飞书渲染时解码一次），含 `?`、`,` 的课时链接在 API 回读时会显示为 `%253F` / `%252C`，属正常存储形态。视频链接本身始终保留在 `--json` 报告里。
- YouTube：WEB 客户端经常被 "Sign in to confirm you're not a bot" 拦截（本机直连被阻断、走代理也可能触发）。适配器因此分层取字幕：innertube → watch 页 `captionTracks` → **yt-dlp 回退** → 可选 `youtube-transcript` 包；四层都失败时抛出可操作的错误（含每层原因、当前代理、yt-dlp 状态）。yt-dlp 必须能被 host 进程启动：若 DSH 运行在受限沙箱里（`spawn EPERM`），错误里会直接写明，此时用 `ytDlpPath` 指向可执行文件或改用 CLI 运行。
- Bilibili 无字幕轨的视频会报“需 UP 主上传字幕”而非静默失败。
- Coursera 需要登录 Cookie；未提供时给出可操作的错误提示。
- `--force` / `--update-doc` 就地重建飞书文档（wiki 链接保持不变）；只有当原地重建失败时才会回退到「新建文档 + 删除旧文档」（旧节点几秒内消失）。大纲文档同理。
- LLM 回退链会把请求依次打到本机所有可用凭据上：首个候选失败时，后面候选所在的服务商能看到相同的内容。如果这不可接受，请只保留一个凭据，或把不需要的凭据从 `$DSH_HOME/.credentials.yaml` 中移除。
