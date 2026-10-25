/**
 * 展示 Local 清单的只读状态，供 App 项目路径栏下方使用。
 * 1. 先提示失效/未知视图，再区分来源发布成功、拒绝、私有保留和正在处理。
 * 2. 无发布凭据时明确私有，不从模型文本、任务完成或工具登记回执推断发布成功。
 * 只使用 API 的安全摘要，不显示控制路径/内部错误码或提供未经实现的恢复操作。
 */
import type { LocalOverlayInfo } from "../shared/types";
import s from "./app.module.css";

export function LocalOverlayStatus({ info }: { info: LocalOverlayInfo }) {
  let message = "修改保留在本对话的私有视图，尚无源码发布记录。";
  if (info.state === "failed" || info.state === "unavailable") {
    message =
      "私有视图需要核查，暂不能继续任务。已保存的历史仍可查看；不会自动重建或回写。";
  } else if (info.publication?.state === "published") {
    message = `所选源码已发布${info.publication.files === undefined ? "" : `（${info.publication.files} 个文件）`}；其他修改仍保留在私有视图。`;
  } else if (info.publication?.state === "rejected") {
    message = "来源冲突或验证未通过，本轮未发布，私有修改已保留。";
  } else if (info.publication?.state === "retained") {
    message = "本轮未发布，私有修改已保留。";
  } else if (info.publication?.state === "publishing") {
    message = "正在验证并发布所选源码，请等待确认结果。";
  } else if (info.publication?.state === "selected") {
    message = "已登记源码选择，尚未发布。";
  }

  return (
    <p role="status" className={s.localOverlayStatus}>
      {message}
    </p>
  );
}
