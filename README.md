# 4SAPI for Copilot Chat

把 **4SAPI 聚合 API**（OpenAI 兼容，650+ 模型）的模型——GPT / Claude / Gemini / DeepSeek / Qwen 等——直接加进 **GitHub Copilot Chat 的模型选择器**，并为**每个模型独立配置上下文长度、最大输出、思考深度、采样参数**。

> 实现模式参考 [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)：不替换 Copilot，而是给 Copilot 加模型。Agent 模式、工具调用、指令文件（AGENTS.md / .instructions.md）、MCP 全部照常可用。
>
> 想要免开发的接入方式？见 [docs/01-VSCode-BYOK-Configuration.md)（VS Code 内置 Custom Endpoint 方案）。

## 功能

- **4SAPI 模型进 Copilot 模型选择器**：按 `4sapi-copilot.models` 配置逐个注册，逐模型元数据（上下文长度、最大输出、工具调用、视觉）。
- **逐模型参数**：`maxInputTokens`（上下文长度）、`maxOutputTokens`（最大输出）、`temperature`、`topP`、`maxTokens`、`stop`、`extraBody`、每模型请求头，全部独立配置。
- **思考深度（Thinking Effort）**：模型选择器内实时切换档位（关闭 / 低 / 中 / 高 / 极限……档位自定义），并按模型族映射成不同的请求参数：
  | `thinking.style` | 适配模型 | 请求参数形状 |
  |---|---|---|
  | `openai` | GPT-5.x、o 系列、Gemini（OpenAI 兼容层）、Qwen/GLM/Kimi | 顶层 `reasoning_effort` |
  | `deepseek` | DeepSeek V4 系 | `thinking:{type:enabled/disabled}` + `reasoning_effort`，流式 `reasoning_content` 渲染为可折叠思考块 |
  | `anthropic` | Claude 系 | `thinking:{type,budget_tokens}`（档位→思考预算映射） |
  | `custom` | 其它 | 仅合并 `thinking.extraBody`，支持 `{{effort}}` 占位符 |
- **一键拉取模型**：`GET /v1/models` 拉取你 Key 下的全部可用模型，多选后自动生成配置（按模型名启发式预填上下文长度 / 思考协议），再到设置里微调。
- **安全**：API Key 存 VS Code SecretStorage（系统钥匙串），不进 settings.json、不进 Git。
- **可观测**：输出通道日志（请求元信息 / 用量 / 耗时，verbose 可看请求体摘要）、token 用量上报给 Copilot（聊天界面显示上下文用量）、`测试连接` 命令。
- **零运行时依赖**：纯 VS Code API + Node 内置 fetch，无 Python / Docker / 本地代理。

## 环境要求

- VS Code **1.116+**（`LanguageModelChatProvider` API）
- GitHub Copilot 扩展（Free / Pro / Enterprise；BYOK 模型不消耗 Copilot 额度，走 4SAPI 自己计费）
- 4SAPI API Key：<https://4sapi.apifox.cn/>（国内直连域名 `4sapi.org` / `4sapi.top` / `4stoken.com`，海外 `4sapi.com`）

## 构建与安装

```bash
npm install
npm run compile        # 编译到 out/
```

**方式 A：开发调试** —— 用 VS Code 打开本目录，按 `F5` 启动 Extension Development Host。

**方式 B：打包安装**：

```bash
npx @vscode/vsce package     # 生成 4sapi-for-copilot-0.1.0.vsix
code --install-extension 4sapi-for-copilot-0.1.0.vsix
```

> 发布到 Marketplace 前请把 `package.json` 里的 `publisher` 改成你自己的 Publisher ID。

## 快速开始

1. `Ctrl+Shift+P` → **`4SAPI: 设置 API Key`**，粘贴 `sk-...`（存入系统钥匙串）。
2. `Ctrl+Shift+P` → **`4SAPI: 测试连接`**，确认 Key 可用、看可用模型数。
3. `Ctrl+Shift+P` → **`4SAPI: 从服务器拉取模型列表并生成配置`**，勾选要暴露的模型 → 自动写入 `4sapi-copilot.models`。
4. 在设置中打开 `4sapi-copilot.models`，按 4SAPI 控制台微调每个模型的参数（见下表）。
5. 回到 Copilot Chat 的**模型选择器**，选择 `xxx (4SAPI)` 模型；模型名旁 `>` 箭头可切换**思考深度**。

默认内置的几个模型条目（gpt-5.5 / claude-sonnet-4-6 / deepseek-v4-* / gemini-2.5-pro）**只是示例参数**，请以 4SAPI 控制台实际模型名与官方参数为准。

## 设置项（`4sapi-copilot.*`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://4sapi.com/v1` | 4SAPI 接入地址，国内换 `4sapi.org/v1` 等 |
| `apiKey` | 空 | 后备明文 Key（不推荐，优先 SecretStorage） |
| `requestHeaders` | `{}` | 全局附加 HTTP 头 |
| `maxTokens` | `0` | 全局 `max_tokens` 上限，`0` = 按模型 `maxOutputTokens` |
| `temperature` / `topP` | `-1` | 全局采样参数，`-1` = 不发送 |
| `enableUsageReporting` | `true` | 向 Copilot 上报 token 用量 |
| `debugMode` | `minimal` | `minimal` / `metadata` / `verbose` |
| `models` | 见下 | 模型清单（核心配置） |

### `models[]` 每个模型的参数

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 必填 | 选择器唯一 ID（也是缺省 `apiModelId`） |
| `apiModelId` | `= id` | **发送给 4SAPI 的模型名** |
| `name` / `family` / `version` / `detail` | — | 展示信息（family 用于分组） |
| `enabled` | `true` | 是否暴露到选择器 |
| `contextWindow` | — | 完整窗口（输入+输出）；设置了它且未设 `maxInputTokens` 时自动推导 |
| `maxInputTokens` | `128000` | **上下文长度**（最大输入 token，Copilot 据此管理上下文预算） |
| `maxOutputTokens` | `32768` | **最大输出 token** |
| `toolCalling` | `true` | 工具调用（Agent 模式必需） |
| `imageInput` | `false` | 图片输入（视觉） |
| `thinking` | — | 思考能力与深度，见下 |
| `temperature` / `topP` | 全局值 | 采样参数（`-1` = 不发送） |
| `maxTokens` | `= maxOutputTokens` | 请求体 `max_tokens` |
| `stop` | — | 停止序列 |
| `extraBody` | — | 合并进请求体的额外参数（最后合并，可覆盖任何生成字段） |
| `requestHeaders` | `{}` | 模型专属请求头 |

### `thinking` 思考配置

| 字段 | 说明 |
|---|---|
| `style` | `none` / `openai` / `deepseek` / `anthropic` / `custom`（映射协议见功能表） |
| `supportedEfforts` | 档位数组，如 `["minimal","low","medium","high"]`、`["low","high","max"]`；设置后选择器出现「思考深度」下拉 |
| `defaultEffort` | 默认档位 |
| `canDisable` | 是否允许 `none`（关闭思考） |
| `effortBudgets` | `anthropic` 风格：档位 → `budget_tokens`，如 `{"low":4096,"high":16384}` |
| `budgetTokens` | `anthropic` 风格的固定思考预算 |
| `extraBody` | 合并进请求体；字符串中的 `{{effort}}` 替换为当前档位（`custom` 风格靠它表达参数） |

示例（DeepSeek V4 Pro）：

```json
{
  "id": "deepseek-v4-pro",
  "name": "DeepSeek V4 Pro (4SAPI)",
  "family": "deepseek",
  "detail": "深度思考 · reasoning_content 流式渲染",
  "maxInputTokens": 655360,
  "maxOutputTokens": 393216,
  "toolCalling": true,
  "imageInput": false,
  "thinking": {
    "style": "deepseek",
    "supportedEfforts": ["low", "high", "max"],
    "defaultEffort": "high",
    "canDisable": true
  }
}
```

## 命令

| 命令 | 作用 |
|---|---|
| `4SAPI: 设置 API Key` | 输入并存入系统钥匙串 |
| `4SAPI: 清除 API Key` | 删除已存 Key |
| `4SAPI: 测试连接` | `GET /v1/models` 验证 Key / 网络 |
| `4SAPI: 从服务器拉取模型列表并生成配置` | 拉模型 → 多选 → 写入 `4sapi-copilot.models` |
| `4SAPI: 重新加载模型列表` | 配置改动后强制刷新选择器 |
| `4SAPI: 打开设置` | 跳转到本扩展设置 |
| `4SAPI: 显示日志` | 打开输出通道 |

## 排查

| 现象 | 处理 |
|---|---|
| 401 | 运行「设置 API Key」重设；确认 Key 属于当前环境域名（国内/海外） |
| 连接超时 | 国内网络把 `baseUrl` 换成 `4sapi.org/v1` / `4sapi.top/v1` / `4stoken.com/v1` |
| 模型不在选择器里 | `enabled: true`？`toolCalling: true`（Agent 会话）？「重新加载模型列表」或重启 VS Code |
| 思考深度下拉不出现 | 配置 `thinking.supportedEfforts` 且 `style != "none"` |
| 思考内容没显示 | 当前 VS Code 不支持 `LanguageModelThinkingPart` 时会跳过渲染（日志有提示）；升级 VS Code |
| 429 / 余额不足 | 4SAPI 控制台查看配额；`debugMode: metadata` 看请求详情 |

## 与内置 BYOK 方案的差异

| 能力 | 内置 Custom Endpoint | 本插件 |
|---|---|---|
| 上下文长度 / 最大输出 | ✅ | ✅ |
| 思考深度切换 | ✅（`supportsReasoningEffort`） | ✅（档位完全自定义） |
| 思考协议映射 | 仅 `reasoning_effort` / `reasoning.effort` / `output_config.effort` | 另支持 DeepSeek `thinking:{}`、Anthropic `budget_tokens`、custom `extraBody` |
| 逐模型 `stop` / `extraBody` | ❌ | ✅ |
| 自动拉取 `/v1/models` 生成配置 | 半自动（provider 级 `url` 发现） | ✅ 一键生成 + 启发式预填 |
| 请求日志 / 用量校准 | ❌ | ✅ |
| DeepSeek `reasoning_content` 思考块渲染 | 依赖 VS Code 内部处理 | ✅ 显式支持 |

## License

MIT
