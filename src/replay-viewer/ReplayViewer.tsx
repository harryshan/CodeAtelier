/**
 * 现有 Web 服务的对话阅读器页面，main.tsx 在 view=replay 且 AccessGate 通过后惰性加载。
 * 不启动额外服务器或要求生成 HTML，不通过 API 上传所选 JSON，也不读取后端历史。
 *
 * 1. ReplayViewer 为共享 DOM 阅读器提供独立容器，页面样式只在此路由加载。
 * 2. effect 设置页面标题并调用 mountViewer；清理时取消搜索计时器、隔离在途文件读取并卸载 DOM。
 * 3. 固定同源返回链接回到主页面，导入的内容不参与路由、脚本或 URL 构造。
 *
 * React StrictMode 可以重复挂载；所有阅读状态属于当前页面，刷新后需重新选择文件。
 */

import { useEffect, useRef } from "react";
import { mountViewer } from "./browser.js";
import "./viewer.css";

export default function ReplayViewer() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "CodeAtelier · 对话阅读器";
    const dispose = mountViewer(container.current!);

    return () => {
      dispose();
      document.title = previousTitle;
    };
  }, []);

  return (
    <main id="app">
      <a className="viewer-home" href="/">
        ← 返回 CodeAtelier
      </a>
      <div ref={container} />
    </main>
  );
}
