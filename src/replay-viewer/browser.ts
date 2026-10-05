/**
 * 自包含 HTML 中运行的只读浏览器入口，由 html.ts 打包，不连接 CodeAtelier 后端。
 * 输入为嵌入的任务 JSON 或用户显式选择的文件；所有不可信内容仅通过 textContent 显示。
 *
 * 1. element/textPanel/panel 创建安全 DOM；大文本分段追加，折叠载荷第一次展开才序列化。
 * 2. mountViewer 建立文件入口、统计、筛选、分页目录和单条详情，避免全量展开大型历史。
 * 3. showEntry 展示模型请求/响应、关联工具、参数结果和原始事件，保留缺失结果与字段。
 * 4. load/import 先完整校验再替换状态；失败保留上次有效文件，文件切换用 generation 防止异步覆盖。
 *
 * 不使用 innerHTML、不渲染可执行 Markdown、不把内容转为链接，也不重放任何调用。
 * 搜索仅在本机内存中进行；离线 HTML 的 CSP 进一步禁止网络、表单和外部资源。
 */

import {
  filterEntries,
  formatValue,
  parseReplayCase,
  projectReplay,
  record,
  statusLabels,
  type ViewerCase,
  type ViewerEntry,
} from "./projection.js";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

function button(text: string, action: () => void) {
  const node = element("button", text);
  node.type = "button";
  node.addEventListener("click", action);

  return node;
}

function textPanel(text: string) {
  const container = element("div");
  const pre = element("pre");
  let length = 20000;
  const more = button("继续显示（每次 20,000 字符）", () => {
    length += 20000;
    update();
  });
  function update() {
    pre.textContent = text.slice(0, length);
    more.hidden = length >= text.length;
  }

  update();
  container.append(pre, more);

  return container;
}

function panel(title: string, value: unknown) {
  const details = element("details");
  details.append(element("summary", title));
  let loaded = false;
  details.addEventListener("toggle", () => {
    if (details.open && !loaded) {
      loaded = true;
      details.append(textPanel(formatValue(value)));
    }
  });

  return details;
}

function select(label: string, options: [string, string][]) {
  const node = element("select");
  node.setAttribute("aria-label", label);
  for (const [value, title] of options) {
    const option = element("option", title);
    option.value = value;
    node.append(option);
  }

  return node;
}

function mountViewer() {
  const root = document.getElementById("app")!;
  const heading = element("h1", "CodeAtelier · 对话阅读器");
  const warning = element(
    "p",
    "离线只读 · 不上传、不执行历史工具。文件可能含源码、提示词和敏感信息，请勿公开或提交。",
  );
  const file = element("input");
  file.type = "file";
  file.accept = ".json,application/json";
  file.setAttribute("aria-label", "选择 Replay JSON");
  const error = element("p");
  error.setAttribute("role", "alert");
  const overview = element("section");
  overview.setAttribute("aria-label", "任务概览");
  const search = element("input");
  search.type = "search";
  search.placeholder = "搜索当前视图中的内容、路径、命令或 ID";
  search.setAttribute("aria-label", "搜索记录");
  const view = select("记录类型", [
    ["rounds", "按轮次（含未关联工具）"],
    ["model", "全部模型调用"],
    ["tool", "全部工具调用"],
    ["event", "历史事件"],
  ]);
  const status = select("记录状态", [
    ["", "全部状态"],
    ["error", "异常"],
    ["unknown", "结果未知"],
    ["recorded", "已记录（不等同成功）"],
  ]);
  const toolbar = element("div");
  toolbar.className = "toolbar";
  toolbar.append(search, view, status);
  const layout = element("div");
  layout.className = "layout";
  const navigation = element("nav");
  navigation.setAttribute("aria-label", "记录目录");
  const list = element("div");
  const pageLabel = element("span");
  pageLabel.setAttribute("aria-live", "polite");
  const detail = element("article");
  detail.setAttribute("aria-label", "记录详情");
  let entries: ViewerEntry[] = [];
  let byKey = new Map<string, ViewerEntry>();
  let filtered: ViewerEntry[] = [];
  let page = 0;
  let selected = "";
  let generation = 0;
  const pageSize = 40;
  const previous = button("上一页", () => {
    page--;
    renderList();
  });
  const next = button("下一页", () => {
    page++;
    renderList();
  });
  const pagination = element("div");
  pagination.className = "toolbar";
  pagination.append(previous, pageLabel, next);
  navigation.append(pagination, list);
  layout.append(navigation, detail);
  root.append(heading, warning, file, error, overview, toolbar, layout);

  function jump(key: string) {
    const entry = byKey.get(key);
    if (!entry) {
      return;
    }

    view.value = entry.kind;
    status.value = "";
    search.value = "";
    filtered = filterEntries(entries, view.value, "", "");
    page = Math.floor(filtered.indexOf(entry) / pageSize);
    selected = key;
    renderList();
    showEntry(entry);
  }

  function showEntry(entry: ViewerEntry) {
    selected = entry.key;
    detail.replaceChildren(
      element("h2", entry.title),
      element("p", `${statusLabels[entry.status]} · ${entry.subtitle}`),
    );
    if (entry.exchange) {
      const exchange = entry.exchange;
      detail.append(
        element("h3", "模型回复"),
        textPanel(
          exchange.response?.text ||
            (exchange.error !== undefined
              ? "模型请求失败，详见错误。"
              : exchange.response
                ? "无展示文本；请查看原始响应中的工具调用或其他协议项。"
                : "未记录终态，不能推断请求成功或失败。"),
        ),
      );
      detail.append(
        element(
          "p",
          `Token 用量：${exchange.response?.usage === undefined ? "未记录" : formatValue(exchange.response.usage)}`,
        ),
      );
      const links = element("div");
      links.className = "tool-links";
      links.append(element("h3", `关联工具（${entry.toolKeys.length}）`));
      for (const key of entry.toolKeys) {
        const tool = byKey.get(key)!;
        links.append(
          button(`${tool.title} · ${statusLabels[tool.status]}`, () =>
            jump(key),
          ),
        );
      }

      detail.append(links);
      detail.append(
        panel(`输入上下文（${exchange.input.length} 项）`, exchange.input),
        panel("系统指令 instructions", exchange.instructions),
        panel(`工具定义（${exchange.tools.length} 项）`, exchange.tools),
        panel("请求选项", exchange.options),
        panel("原始响应（含协议输出）", exchange.response),
      );
      if (exchange.error !== undefined) {
        detail.append(panel("模型错误", exchange.error));
      }
    } else if (entry.tool) {
      const tool = entry.tool;
      if (entry.modelKey) {
        detail.append(button("返回所属模型调用", () => jump(entry.modelKey!)));
      }

      detail.append(
        element("p", `DAG 节点：${tool.nodeId} · 批次：${tool.batchId}`),
      );
      detail.append(
        element("h3", "依赖节点"),
        textPanel(tool.dependsOn.join("\n") || "无"),
      );
      detail.append(
        element("h3", "调用参数"),
        textPanel(formatValue(tool.arguments)),
      );
      const result = record(tool.result);
      for (const field of ["text", "output"]) {
        if (typeof result[field] === "string") {
          detail.append(
            element("h3", `结果正文 · ${field}`),
            textPanel(result[field]),
          );
        }
      }

      if (tool.result === undefined) {
        detail.append(element("p", "结果未知：没有保存返回值；不会自动重放。"));
      }

      detail.append(panel("完整工具结果", tool.result));
    } else {
      detail.append(textPanel(formatValue(record(entry.raw).data)));
    }

    detail.append(panel("原始记录（保留扩展字段）", entry.raw));
    for (const node of list.querySelectorAll("button")) {
      node.setAttribute("aria-current", String(node.dataset.key === selected));
    }
  }

  function renderList() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    pageLabel.textContent = `${filtered.length} 条 · ${page + 1} / ${pages} 页`;
    previous.disabled = page === 0;
    next.disabled = page + 1 === pages;
    list.replaceChildren();
    for (const entry of filtered.slice(
      page * pageSize,
      (page + 1) * pageSize,
    )) {
      const item = button("", () => showEntry(entry));
      item.className = `entry ${entry.status}`;
      item.dataset.key = entry.key;
      item.setAttribute("aria-current", String(entry.key === selected));
      item.append(
        element("strong", entry.title),
        element("span", `${statusLabels[entry.status]} · ${entry.subtitle}`),
      );
      list.append(item);
    }
  }

  function refresh() {
    page = 0;
    filtered = filterEntries(entries, view.value, status.value, search.value);
    selected = filtered[0]?.key ?? "";
    renderList();
    if (filtered[0]) {
      showEntry(filtered[0]);
    } else {
      detail.replaceChildren(
        element("p", "没有匹配记录。试试其他类型、状态或关键词。"),
      );
    }
  }

  function load(value: unknown, name: string) {
    const data: ViewerCase = parseReplayCase(value);
    const projected = projectReplay(data);
    entries = projected;
    byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const models = data.capture?.modelExchanges ?? [];
    overview.replaceChildren(
      element("h2", data.session.title),
      element(
        "p",
        `${name} · ${data.source} · 任务 ${data.task.id} · ${data.task.status}`,
      ),
      element("p", `工作区：${data.session.workspace}`),
      element(
        "p",
        `模型请求 ${models.length} · 工具调用 ${data.tools.length} · 历史事件 ${data.events.length} · 异常记录 ${entries.filter((entry) => entry.status === "error").length} · 未知结果 ${entries.filter((entry) => entry.status === "unknown").length}`,
      ),
    );
    overview.append(
      element(
        "p",
        "编号是捕获顺序，step/attempt 为原始值；关联仅依据唯一 call_id。已记录不代表成功，缺失用量/时间不记为零。",
      ),
    );
    if (!models.length) {
      overview.append(
        element(
          "p",
          "没有捕获模型请求。可查看已有工具和历史事件，不能重建缺失轮次。",
        ),
      );
    }

    overview.append(
      panel("任务、会话及捕获元数据", {
        session: data.session,
        task: data.task,
        capture: data.capture
          ? Object.fromEntries(
              Object.entries(data.capture).filter(
                ([key]) => key !== "modelExchanges" && key !== "tools",
              ),
            )
          : undefined,
      }),
    );
    view.value = "rounds";
    status.value = "";
    search.value = "";
    error.textContent = "";
    refresh();
  }

  function reportError(cause: unknown) {
    error.textContent =
      cause instanceof SyntaxError
        ? "JSON 解析失败；请检查文件是否完整。"
        : cause instanceof Error
          ? cause.message
          : "无法读取文件。";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
  view.addEventListener("change", refresh);
  status.addEventListener("change", refresh);
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    const current = ++generation;
    if (!chosen) {
      return;
    }

    try {
      const text = await chosen.text();
      if (current === generation) {
        load(JSON.parse(text), chosen.name);
      }
    } catch (cause) {
      if (current === generation) {
        reportError(cause);
      }
    }
  });
  try {
    const embedded = JSON.parse(
      document.getElementById("replay-data")!.textContent!,
    );
    if (embedded !== null) {
      load(embedded, "内嵌 Replay Case");
    } else {
      refresh();
    }
  } catch (cause) {
    reportError(cause);
  }
}

mountViewer();
