/**
 * 为 McpTaskClient 管理官方 SDK 的 stdio transport，保证握手失败和任务收尾共享真实关闭进度。
 * SDK 的 Client.connect 在初始化失败后会异步调用 close；本类不改变握手、命令或权限契约。
 *
 * 1. startedPid 只读提供本连接保存的 PID，供任务客户端在 SDK 清空内部句柄后仍核对退出。
 * 2. start 在 SDK 创建子进程后保存 PID，不启动、重试或重放额外请求。
 * 3. close 缓存首次 SDK 关闭的 Promise；重复关闭等待相同回执，不能因内部句柄已清空而提前返回；清理期限仍由任务客户端控制。
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class McpStdioTransport extends StdioClientTransport {
  private processId: number | null = null;
  private closePromise?: Promise<void>;

  get startedPid() {
    return this.processId;
  }

  override async start() {
    const started = super.start();
    this.processId ??= this.pid;
    await started;
    this.processId ??= this.pid;
  }

  override close(): Promise<void> {
    this.closePromise ??= super.close();

    return this.closePromise;
  }
}
