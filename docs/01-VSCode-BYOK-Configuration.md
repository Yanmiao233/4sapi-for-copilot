# 在 VS Code 的 GitHub Copilot 中接入 4SAPI —— 配置步骤

> 目标：把 4SAPI 聚合 API（OpenAI 兼容，650+ 模型）的模型加进 Copilot Chat 的模型选择器，并为**每个模型单独配置上下文长度、最大输出、思考深度、采样参数**等。
>
> 4SAPI 接入地址：海外 `https://4sapi.com/v1`；国内直连 `https://4sapi.org/v1` / `https://4sapi.top/v1` / `https://4stoken.com/v1`（文档：<https://4sapi.apifox.cn/>）。

三种方案，按需求二选一：

| 方案 | 适用场景 | 参数控制粒度 | 是否需要开发 |
|---|---|---|---|
| **方案一：VS Code 内置 BYOK（Custom Endpoint）** | 5 分钟接入，日常够用 | 上下文长度、最大输出、思考深度、temperature/top_p | 否，只改配置 |
| **方案二：自研插件 `4sapi-for-copilot`** | 要逐模型全参数控制、思考协议映射、自动拉模型、调试日志 | 全量（含 stop、extraBody、每模型请求头、思考协议） | 是，见 `../README.md` |
| 方案三：Continue / Cline 等第三方插件 | 不用 Copilot Chat 界面 | 一般 | 否 |

---

## 方案一：VS Code 内置 BYOK（推荐先试这个）

### 前提

- VS Code **1.105+**（建议最新稳定版；官方文档见 [AI language models in VS Code](https://code.visualstudio.com/docs/agent-customization/language-models)）
- GitHub Copilot 扩展（Free / Pro / Enterprise 均可；BYOK 模型甚至可以不登录 GitHub 账号使用）
- 4SAPI API Key（控制台创建，形如 `sk-...`）

### 步骤

1. **打开模型管理**：点击 Copilot Chat 输入框的**模型选择器** → **Manage Language Models**（齿轮图标）；
   或 `Ctrl+Shift+P`（macOS `Cmd+Shift+P`）→ 运行 **`Chat: Manage Language Models`**。

2. **添加模型**：点 **Add Models** → 选择 **Custom Endpoint**（自定义端点）。
   > 注意：不要选已弃用的 "OpenAI Compatible"，旧设置 `github.copilot.chat.customOAIModels` 也已弃用，一律走 Custom Endpoint。

3. **填写连接信息**：
   - 分组名（Group name）：`4SAPI`
   - 显示名 & API Key：填 4SAPI 的 `sk-...` Key
   - API 类型：**Chat Completions**（4SAPI 为 OpenAI 兼容协议）

4. **编辑 `chatLanguageModels.json`**：VS Code 会自动打开配置文件，把下面的模板粘进去（把模型名换成你 4SAPI 控制台里实际可用的），保存：

   ```json
   [
     {
       "name": "4SAPI",
       "vendor": "customendpoint",
       "apiKey": "${input:4sapiApiKey}",
       "apiType": "chat-completions",
       "models": [
         {
           "id": "gpt-5.5",
           "name": "GPT-5.5 (4SAPI)",
           "url": "https://4sapi.com/v1/chat/completions",
           "toolCalling": true,
           "vision": true,
           "thinking": true,
           "maxInputTokens": 200000,
           "maxOutputTokens": 64000,
           "supportsReasoningEffort": ["minimal", "low", "medium", "high"],
           "reasoningEffortFormat": "chat-completions",
           "modelOptions": {
             "temperature": 0.2
           }
         },
         {
           "id": "claude-sonnet-4-6",
           "name": "Claude Sonnet 4.6 (4SAPI)",
           "url": "https://4sapi.com/v1/chat/completions",
           "toolCalling": true,
           "vision": true,
           "thinking": true,
           "maxInputTokens": 200000,
           "maxOutputTokens": 64000,
           "supportsReasoningEffort": ["low", "medium", "high", "max"],
           "reasoningEffortFormat": "chat-completions"
         },
         {
           "id": "deepseek-v4-pro",
           "name": "DeepSeek V4 Pro (4SAPI)",
           "url": "https://4sapi.com/v1/chat/completions",
           "toolCalling": true,
           "vision": false,
           "thinking": true,
           "maxInputTokens": 655360,
           "maxOutputTokens": 393216,
           "supportsReasoningEffort": ["low", "high", "max"],
           "reasoningEffortFormat": "chat-completions"
         }
       ]
     }
   ]
   ```

   说明：
   - `"apiKey": "${input:4sapiApiKey}"` 是密钥引用（通过 **Update API Key** 按钮生成，密钥存系统钥匙串）。赶时间也可以直接写 `"apiKey": "sk-你的Key"`（明文进配置文件，不推荐）。
   - 国内网络把 URL 里的 `4sapi.com` 换成 `4sapi.org` / `4sapi.top` / `4stoken.com`。
   - 想让 VS Code **自动发现模型**（不手写 `models` 数组）：在 provider 级加 `"url": "https://4sapi.com/v1"`，VS Code 会查询端点拉取模型列表，之后再补参数。
   - 更多字段见下方参考表。

5. **使用**：回到聊天输入框的模型选择器，选 4SAPI 分组下的模型即可（没出现就 `Reload Window`）。
   - **思考深度**：模型旁的 `>` 箭头 → **Thinking Effort** 子菜单，随时切换档位（`supportsReasoningEffort` 配置了才显示）。
   - **Agent 模式**：`toolCalling: true` 的模型才会出现在 Agent 会话的模型选择器里。
   - 可在 Language Models 编辑器里用眼睛图标隐藏/显示模型、用图钉固定常用模型。

### 每个模型的参数怎么配（关键）

| 字段 | 作用 | 示例 |
|---|---|---|
| `id` | **发送给 4SAPI 的模型名**（务必与控制台一致） | `"gpt-5.5"` |
| `name` | 选择器里显示的名字 | `"GPT-5.5 (4SAPI)"` |
| `url` | 完整端点 URL（含 API 路径） | `"https://4sapi.com/v1/chat/completions"` |
| `maxInputTokens` | **上下文长度**（最大输入 token） | `200000` |
| `maxOutputTokens` | **最大输出 token** | `64000` |
| `contextWindow` | 模型完整窗口（输入+输出），设置后可省略 `maxInputTokens`，VS Code 按 `contextWindow - maxOutputTokens` 推导 | `264000` |
| `thinking` | 模型支持思考模式 | `true` |
| `supportsReasoningEffort` | **思考深度档位**，设置后选择器出现 Thinking Effort 下拉 | `["low","medium","high"]` |
| `reasoningEffortFormat` | 思考深度发给模型的参数形状：`chat-completions` → 顶层 `reasoning_effort`；`responses` → `reasoning.effort`；`messages` → `output_config.effort` | `"chat-completions"` |
| `modelOptions` | 每次请求附带的采样参数 | `{"temperature":0.2,"top_p":0.9}` |
| `toolCalling` | 支持工具调用（Agent 必需） | `true` |
| `vision` | 支持图片输入 | `true` |
| `editTools` | 支持的编辑工具：`find-replace` / `multi-find-replace` / `apply-patch` / `code-rewrite` | `["apply-patch"]` |
| `requestHeaders` | 自定义请求头（值里可写 `${apiKey}` 引用密钥） | `{"X-Custom":"1"}` |
| `apiType` | 覆盖 provider 级 API 类型 | `"messages"` |

⚠️ 两个必须注意的点：

1. **`maxInputTokens + maxOutputTokens` 不要超过模型的真实上下文窗口**——VS Code 用两者之和作为总窗口来显示上下文用量，超了显示会失真。通常令 `maxInputTokens = 上下文窗口 - maxOutputTokens`。
2. 模型名 / 参数（真实窗口、是否支持思考）**以 4SAPI 控制台和对应模型官方文档为准**，上面模板里的数字是常见配置示例。

---

## 方案二：自研插件 `4sapi-for-copilot`（全参数可控）

方案一的 `chatLanguageModels.json` 能覆盖 90% 需求，但以下场景不够用：

- DeepSeek 系需要 `thinking:{type:...}` + `reasoning_content` 回填（缓存命中率、思考块渲染）；
- Claude 系思考深度要映射成 `thinking.budget_tokens`，而不是 `reasoning_effort`；
- 需要逐模型 `stop`、`extraBody` 自定义参数、每模型请求头；
- 需要在**同一插件里管理多个 Key（多个分组）**，并按分组显示各自倍率；
- 想一条命令拉取某 Key 的可用模型、自动推断其分组并生成配置，不想手写 JSON；
- 想要请求日志、用量校准、连接测试等调试能力。

这些都做进了 `4sapi-for-copilot` 插件，用法见 [`../README.md`](../README.md)。构建：

```bash
cd 4sapi-for-copilot
npm install
npm run compile      # 或 npm run package 生成 .vsix
```

安装后：`Ctrl+Shift+P` → **4SAPI: 添加 API Key**（粘贴按分组创建的 Key → 确认自动推断出的分组与倍率 → 勾选要暴露的模型）。想再加别的分组就重复一次；模型在选择器里显示为 `模型名 (倍率, 分组)`，需要时在设置里按 Key 调整 `modelOverrides`（`maxInputTokens` 上下文长度、`thinking` 思考深度等）。

---

## 方案三：Continue / Cline（补充）

不依赖 Copilot Chat 界面时，Continue 的 `config.json` 也能接 4SAPI：

```json
{
  "models": [
    {
      "title": "GPT-5.5 @ 4SAPI",
      "provider": "openai",
      "model": "gpt-5.5",
      "apiKey": "sk-你的Key",
      "apiBase": "https://4sapi.com/v1",
      "contextLength": 200000,
      "completionOptions": { "maxTokens": 64000, "temperature": 0.2 }
    }
  ]
}
```

---

## 排查

| 现象 | 处理 |
|---|---|
| 401 / 无效 Key | Key 是否复制完整（`sk-` 开头）、是否已激活套餐；国内网络换 `4sapi.org` 等域名 |
| 模型不出现 | `toolCalling` 必须为 `true`（Agent 会话）；重启 VS Code；确认 `id` 与 4SAPI 模型名完全一致 |
| 思考深度下拉不显示 | 模型需 `thinking: true` + `supportsReasoningEffort` 非空 |
| 上下文用量显示异常 | 调整 `maxInputTokens` / `maxOutputTokens`，使其之和 = 真实窗口 |
| 429 / 配额 | 4SAPI 控制台查看余额与限流策略 |
