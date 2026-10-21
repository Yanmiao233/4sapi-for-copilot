# 4SAPI for Copilot Chat

把 **4SAPI 聚合 API**（OpenAI 兼容）的模型——GPT / Claude / Gemini / DeepSeek / Qwen 等——直接加进 **GitHub Copilot Chat 的模型选择器**。

4SAPI 的运行模式是**固定 URL + 多 Key**：接入地址固定，不同分组通过**创建不同的 Key** 来调用，同一模型在不同分组下按**不同倍率**计费。本扩展围绕这一点设计：

- **一个 Key 一个分组**：每个 Key 绑定 4SAPI 控制台中创建它时选择的分组，可用模型由该分组决定。
- **模型名自带倍率**：模型在选择器里显示为 `claude-sonnet-4-6 (5x, claude-官方)`，所以**不同分组下的同名模型不会冲突或混淆**。
- **随时增删 Key**：添加 Key 时自动拉取该 Key 的可用模型、自动推断分组与倍率，勾选要暴露的模型；删除 Key 时连同它的模型一起清理。

> 实现模式参考 [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)：不替换 Copilot，而是给 Copilot 加模型。Agent 模式、工具调用、指令文件（AGENTS.md / .instructions.md）、MCP 全部照常可用。
>
> 想要免开发的接入方式？见 [docs/01-VSCode-BYOK-Configuration.md](docs/01-VSCode-BYOK-Configuration.md)（VS Code 内置 Custom Endpoint 方案）。

## 功能

- **多 Key 驱动模型**：配置 `4sapi-copilot.keys[]`，每个 Key 一个分组、一份模型清单。增删 Key 用命令完成，无需手写 JSON。
- **Key 决定模型，模型显示倍率**：模型名形如 `gpt-5.5 (5x, 企业推荐全模型分组)`；倍率取自 4SAPI 公开倍率表 `GET /api/pricing` 的 `group_ratio`，即控制台展示的分组倍率。
- **自动推断分组**：`GET /v1/models` 返回的模型已按 Key 的权限过滤，其可用分组即该 Key 的分组 → 添加 Key 时自动列出候选分组（含倍率与该分组下的模型数），确认即可。
- **逐模型参数**：上下文长度、最大输出、思考深度、采样参数等**按 `/api/pricing` 的模型元数据（上下文规格标签、供应商、模型族）自动推导**，需要时可在 `keys[].modelOverrides` 里覆盖。
- **思考深度（Thinking Effort）**：模型选择器内实时切换档位（关闭 / 低 / 中 / 高 / 极限……档位自定义），并按模型族映射成不同的请求参数：
  | `thinking.style` | 适配模型 | 请求参数形状 |
  |---|---|---|
  | `openai` | GPT-5.x、o 系列、Gemini（OpenAI 兼容层）、Qwen/GLM/Kimi | 顶层 `reasoning_effort` |
  | `deepseek` | DeepSeek V4 系 | `thinking:{type:enabled/disabled}` + `reasoning_effort`，流式 `reasoning_content` 渲染为可折叠思考块 |
  | `anthropic` | Claude 系 | `thinking:{type,budget_tokens}`（档位→思考预算映射） |
  | `custom` | 其它 | 仅合并 `thinking.extraBody`，支持 `{{effort}}` 占位符 |
- **安全**：每个 Key 的明文只存 VS Code SecretStorage（系统钥匙串），settings.json 里只有分组、别名等非机密元数据。删除 Key 会同时清理密钥库条目。添加 Key 时会立即**回读校验**，确保密钥真的写进去了才保存配置。
- **可观测**：输出通道日志（Key / 分组 / 倍率 / 模型 / 思考深度 / 用量 / 耗时，verbose 可看请求体摘要）、token 用量上报给 Copilot、`测试连接` 命令逐个 Key 体检。
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
npx @vscode/vsce package     # 生成 4sapi-for-copilot-0.2.0.vsix
code --install-extension 4sapi-for-copilot-0.2.0.vsix
```

> 发布到 Marketplace 前请把 `package.json` 里的 `publisher` 改成你自己的 Publisher ID。

## 快速开始

1. `Ctrl+Shift+P` → **`4SAPI: 添加 API Key`**：
   1. 粘贴在 4SAPI 控制台**按目标分组创建**的 `sk-...`（存入系统钥匙串）；
   2. 扩展拉取该 Key 的可用模型并**推断出分组** → 在列表里确认分组（显示该分组倍率与可用模型数）；
   3. 勾选要暴露到 Copilot 的模型，回车确认；
   4. 给这个 Key 起个别名（默认用分组名）。
2. 回到 Copilot Chat 的**模型选择器**，选择形如 `claude-sonnet-4-6 (5x, claude-官方)` 的模型；模型名旁 `>` 箭头可切换**思考深度**。
3. 需要别的分组？重复第 1 步再加一个 Key。想调整某个 Key 暴露的模型 → **`4SAPI: 编辑 Key 的模型列表`**；不想要了 → **`4SAPI: 删除 API Key`**（密钥与该 Key 的模型一并清理）。
4. 需要逐模型微调参数（上下文长度、最大输出、思考深度……）→ 在设置里编辑对应 Key 的 `modelOverrides`。

> 从旧版本（0.1.x）升级：首次启动会把原来的单个 API Key 与 `models` 列表**自动迁移**成第一个 Key 条目（含分组与倍率推断），并清理已废弃的设置项。

## 设置项（`4sapi-copilot.*`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://4sapi.com/v1` | 4SAPI 接入地址，国内换 `4sapi.org/v1` 等 |
| `keys` | `[]` | **API Key 清单（核心配置）**，见下 |
| `requestHeaders` | `{}` | 全局附加 HTTP 头 |
| `maxTokens` | `0` | 全局 `max_tokens` 上限，`0` = 按模型 `maxOutputTokens` |
| `temperature` / `topP` | `-1` | 全局采样参数，`-1` = 不发送 |
| `enableUsageReporting` | `true` | 向 Copilot 上报 token 用量 |
| `debugMode` | `minimal` | `minimal` / `metadata` / `verbose` |

### `keys[]` 每个 Key 的字段

> 明文 Key 不在 settings.json 里，而是按 `id` 存进系统密钥库（`4sapi-copilot.key.<id>`），所以 settings.json 可以放心同步/分享。

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 必填 | 内部唯一 ID（自动生成，用于密钥键名与选择器 ID，**请勿手改**） |
| `alias` | `= group` | Key 别名，会出现在模型描述里 |
| `enabled` | `true` | 关闭后该 Key 的全部模型从选择器消失 |
| `group` | — | 该 Key 绑定的 4SAPI 分组（创建 Key 时选的那个） |
| `groupRatio` | — | 分组消耗倍率，取自 `/api/pricing`；仅用于显示，倍率表不可用时作为兜底 |
| `models` | — | 暴露到选择器的模型名清单（4SAPI 原始模型名） |
| `modelOverrides` | — | 逐模型参数覆盖，见下 |

### `keys[].modelOverrides[模型名]`

**全部字段都可省略**——缺省时按 `/api/pricing` 的元数据自动推导（`tags` 里的 `1M` / `200K` 等规格标签 → 完整上下文窗口，输入上限 = 窗口 − 最大输出；`vendor_id` → 供应商；模型名 → 模型族与思考协议）。只需填写要调整的字段：

| 字段 | 自动推导值 | 说明 |
|---|---|---|
| `apiModelId` | `= 模型名` | **发送给 4SAPI 的模型名** |
| `name` | `模型名 (倍率, 分组)` | 选择器显示名 |
| `family` / `version` / `detail` | 按模型族 | 展示信息（`family` 用于分组） |
| `contextWindow` | `tags` 规格标签 | 完整窗口（输入+输出） |
| `maxInputTokens` | `contextWindow − maxOutputTokens` | **上下文长度**（Copilot 据此管理上下文预算） |
| `maxOutputTokens` | 按模型族（如 Gemini 65536） | **最大输出 token** |
| `toolCalling` | `true` | 工具调用（Agent 模式必需） |
| `imageInput` | `tags` 含「多模态」 | 图片输入（视觉） |
| `thinking` | 按模型族 | 思考能力与深度，见下 |
| `temperature` / `topP` | 全局值 | 采样参数（`-1` = 不发送） |
| `maxTokens` | `= maxOutputTokens` | 请求体 `max_tokens` |
| `stop` | — | 停止序列 |
| `extraBody` | — | 合并进请求体的额外参数（最后合并，可覆盖任何生成字段） |
| `requestHeaders` | `{}` | 模型专属请求头 |

示例（某个 Key 下只调整 DeepSeek V4 Pro 的显示名与上下文长度）：

```json
{
  "id": "key-legacy",
  "alias": "国产Key",
  "group": "deepseek",
  "groupRatio": 0.8,
  "models": ["deepseek-v4-pro", "deepseek-v4.1-flash"],
  "modelOverrides": {
    "deepseek-v4-pro": {
      "name": "DeepSeek V4 Pro（满血，0.8x）",
      "maxInputTokens": 655360,
      "maxOutputTokens": 393216,
      "thinking": {
        "style": "deepseek",
        "supportedEfforts": ["low", "high", "max"],
        "defaultEffort": "high",
        "canDisable": true
      }
    }
  }
}
```

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

示例（DeepSeek V4 Pro 的思考配置片段，放在 `modelOverrides["deepseek-v4-pro"].thinking`）：

```json
{
  "style": "deepseek",
  "supportedEfforts": ["low", "high", "max"],
  "defaultEffort": "high",
  "canDisable": true
}
```

## 命令

| 命令 | 作用 |
|---|---|
| `4SAPI: 添加 API Key` | 输入 Key → 拉取可用模型 → 确认分组与倍率 → 勾选模型 → 取别名 |
| `4SAPI: 删除 API Key` | 删除密钥 + 该 Key 的全部模型 |
| `4SAPI: 编辑 Key 的模型列表` | 重新拉取该 Key 可用模型并多选 |
| `4SAPI: 重命名 Key` | 修改 Key 别名（选择器里用于区分） |
| `4SAPI: 刷新分组倍率表` | 强制重新拉取 `/api/pricing`，更新模型名里的倍率 |
| `4SAPI: 测试连接` | 逐个 Key 调 `GET /v1/models` 验证连通与可用模型数 |
| `4SAPI: 重新加载模型列表` | 配置改动后强制刷新选择器 |
| `4SAPI: 打开设置` | 跳转到本扩展设置 |
| `4SAPI: 显示日志` | 打开「输出」面板的 **4SAPI** 通道（会自动切过去） |
| `4SAPI: 诊断信息` | 打印每个 Key 的分组 / 倍率 / **密钥是否已在密钥库中**、倍率表缓存状态（不受 `debugMode` 限制） |

> **日志在哪看？** 两种方式等价：① 命令 `4SAPI: 显示日志` / `4SAPI: 诊断信息`（会自动打开面板并切换通道）；② 手动 `Ctrl+Shift+U`（或「查看 → 输出」），在面板**右上角的下拉框**里选 `4SAPI`。
>
> 注意：`debugMode: minimal`（默认）只记录错误，所以请求正常时除了启动横幅外基本没有内容 —— 想看请求详情请把 `4sapi-copilot.debugMode` 设为 `metadata` 或 `verbose`。

## 排查

| 现象 | 处理 |
|---|---|
| 添加 Key 时报 401 | 确认 Key 有效、且属于当前 `baseUrl` 域名（国内/海外 Key 不通用） |
| 添加 Key 时报「未返回任何模型」 | 检查该 Key 的分组与套餐权限 |
| 分组推断不对 | 倍率表不可用时会退化为手动输入分组名与倍率；也可在设置里直接改该 Key 的 `group` / `groupRatio` |
| 倍率显示 `倍率未知` | 该分组不在 `/api/pricing` 的 `group_ratio` 里（多为展示用分组）；运行「刷新分组倍率表」，或在设置里手填 `groupRatio` |
| 模型名里倍率不是最新的 | 运行「4SAPI: 刷新分组倍率表」（倍率表有 12 小时缓存，过期会自动刷新） |
| 连接超时 | 国内网络把 `baseUrl` 换成 `4sapi.org/v1` / `4sapi.top/v1` / `4stoken.com/v1` |
| 模型不在选择器里 | 该 Key 的 `enabled: true`？模型在 `models` 里？`toolCalling`（Agent 会话必需）？「重新加载模型列表」或重启 VS Code |
| 思考深度下拉不出现 | 该模型推导出的 `thinking` 不是 `none`（Claude / GPT / Gemini / DeepSeek / Qwen 系默认有档位） |
| 思考内容没显示 | 当前 VS Code 不支持 `LanguageModelThinkingPart` 时会跳过渲染（日志有提示）；升级 VS Code |
| 429 / 余额不足 | 4SAPI 控制台查看配额；`debugMode: metadata` 看请求详情（日志含 Key 别名与分组） |
| 「显示日志」打开是空白 | `debugMode: minimal` 时只记录错误，正常情况下只有启动横幅。要看请求详情请把 `debugMode` 设为 `metadata` / `verbose`。面板在「查看 → 输出」（`Ctrl+Shift+U`），右上角下拉框选 `4SAPI`。 |
| 找不到日志输出在哪 | 命令 `4SAPI: 显示日志` 或 `4SAPI: 诊断信息` 会自动打开面板并切到 `4SAPI` 通道。 |
| 密钥疑似没保存 | 运行 `4SAPI: 诊断信息`：会列出每个 Key 的密钥状态（已存 ✓ / 缺失 ✗）与密钥库条目。添加 Key 时会立即回读校验，写入失败会明确报错并**不留下坏配置**。 |

## 与内置 BYOK 方案的差异

| 能力 | 内置 Custom Endpoint | 本插件 |
|---|---|---|
| 上下文长度 / 最大输出 | ✅ | ✅ |
| 思考深度切换 | ✅（`supportsReasoningEffort`） | ✅（档位完全自定义） |
| 思考协议映射 | 仅 `reasoning_effort` / `reasoning.effort` / `output_config.effort` | 另支持 DeepSeek `thinking:{}`、Anthropic `budget_tokens`、custom `extraBody` |
| 逐模型 `stop` / `extraBody` | ❌ | ✅ |
| 多 Key / 多分组 | ❌（单 endpoint） | ✅（一 Key 一分组，模型名带倍率） |
| 模型参数自动推导 | ❌（手填） | ✅（按 `/api/pricing` 元数据） |
| 请求日志 / 用量校准 | ❌ | ✅ |
| DeepSeek `reasoning_content` 思考块渲染 | 依赖 VS Code 内部处理 | ✅ 显式支持 |

## License

MIT

