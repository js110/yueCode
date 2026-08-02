# Yue

Yue 是我自用的，基于事件驱动架构的 agent。你的每一次对话、工具调用和文件修改，都是不可变日志里的一条事件。UI、LLM 上下文和会话树，都只是这条日志的投影。

[English](./README.md)

## 关于它

Yue 的表壳来源于 Pi -> Yue, 感谢 Pi 的开源。

Yue 是 [pizza](https://github.com/tomsun28/pizza) 的一个 fork。pizza 是一个开源的事件驱动编码 agent。向它致敬：Reactor 驱动的 turn 循环、SQLite 事件存储、单 CLI 工具的设计，都继承自它。我们站在原作者的肩膀上，也站在更早的 Pi 项目之上。

- **Reactor 驱动的 turn 循环**
  区别于 `Pi, Claude Code, Codex`，Yue 没有用一个脆弱的 `while true` 循环来跑 agent 主循环。每一次 turn 都是一张事件-处理器表驱动的状态机。结果是：中断、重试、并行工具调用、turn 内失败都能被可靠处理。

- **日志是唯一事实来源**
  每一条消息、每一次模型调用、每一个工具结果、每一次文件变更，都会被写入不可变的 `EventStore`（SQLite）。UI、LLM 上下文、会话树都是这条日志的实时投影。状态不再藏在可变对象里 —— 它可以被重建、审计、回放，因为日志就是唯一的事实来源。

- **只有一个执行工具 - CLI**
  JSON 在 API 层对程序处理友好但对模型可不是，Yue 激进的只提供给模型一个工具 - `CLI Tool`, 模型通过其来调用 `read`、`write`、`edit` 和其它命令行命令，出乎意料的是，它表现的更好更稳。

- **为什么要 New Session**
  在 Yue 中你不需要手工去新建会话，把它看作你可以持续聊十年的朋友的长程任务，朋友自己会去管理好自己的上下文。

- **所有界面共享同一个运行时**
  桌面 GUI、交互式 TUI、JSON-RPC 服务、单次打印模式都消费同一个 `SessionFacade` 的事件流。你可以脚本化它、嵌入它，或者直接在终端聊天 —— 它是同一个 agent。

- **Git Log 一样的分支树记忆**
  会话可以从任意一条历史消息分叉。回退、分支、对比。随时随地重开人生。  

- **子代理图工作流**
  主 agent 可以用 `_workflow` 编排多步委托：一个由 `delegate` / `verify` / `synthesize` 节点组成的 JSON DAG 会保存到 agent 目录下，可以按名字反复运行，零 token 协调 —— 定义即计划。只有子代理的最终回复会进入你的上下文。

## 子代理工作流（图 DAG）

除了单次委托，Yue 还让持久化主 agent 可以编排多步子代理图。一个工作流就是一张节点 JSON DAG：

- `delegate` —— 把任务扇出到每个项目目录（需要 `task`）。
- `verify` —— 为每个目录生成一个全新的验证器，检查验收标准（需要 `criteria`）。
- `synthesize` —— 一个全新 agent 审查所有上游输出（需要 `task` + 1 个 cwd）。

工作流以每个工作流一个 JSON 文件的形式持久化在 `<agentDir>/workflows/<name>.json`，所以保存过的图可以按名字重新运行。`dependsOn` 满足的节点并行运行；每个目标的生成失败会被记录下来但不会中止整个图，因此 `verify` 节点仍然可以检查部分完成的工作。

```json
{
  "name": "fix-auth",
  "description": "Fix the auth bug across projects",
  "nodes": [
    {
      "id": "workers",
      "kind": "delegate",
      "cwds": ["../proj-a", "../proj-b"],
      "task": "fix the auth bug and summarize the change"
    },
    {
      "id": "check",
      "kind": "verify",
      "cwds": ["../proj-a", "../proj-b"],
      "criteria": "the auth fix lands and all tests pass",
      "dependsOn": ["workers"]
    },
    {
      "id": "report",
      "kind": "synthesize",
      "cwds": ["."],
      "task": "summarize the overall status of the auth fix across all projects",
      "dependsOn": ["check"]
    }
  ]
}
```

```bash
_workflow list
_workflow save fix-auth --definition '{...}'   # 也可以用 <<EOF heredoc 形式
_workflow run fix-auth
_workflow show fix-auth
_workflow delete fix-auth
```

`_delegate_agent` 和 `_workflow` 只有主（持久化）agent 可用。每个子代理运行在自己的工作区（独立事件存储）里，只有它的最终回复会被返回 —— 中间输出不会进入主 agent 的上下文。

## 快速开始

### 桌面应用

从 [GitHub Releases](https://github.com/js110/yueCode/releases) 下载对应平台的安装包（macOS / Linux / Windows），安装后打开即可使用。

> **macOS 用户**：由于应用未经签名，打开时可能会提示"Yue.app 已损坏，无法打开。"请在终端执行 `xattr -cr /Applications/Yue.app` 即可解决。

### CLI

```bash
npm install -g @js110/yue
export ZAI_API_KEY=your_zai_api_key
yue
```

---

![desktop](./resources/yue-desktop-white.png)