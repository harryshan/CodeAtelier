/**
 * 展示 Local 清单状态及检查/继续入口，供 App 项目路径栏下方使用。
 * 1. 先提示失效/未知视图，再区分来源发布成功、拒绝、私有保留和正在处理。
 * 2. 无发布凭据时明确私有，不从模型文本、任务完成或工具登记回执推断发布成功。
 * 3. ready 且平台支持时展示明确选集的内容检查；状态/代次/会话变化销毁旧内容和未完成请求。
 * 4. 冲突继续会话标明旧材料仅供参考，创建回调交回 App；不直接恢复旧卷或发布文件。
 * 5. 待核查批次提供来源事故入口；清单提示不是原生排空证明，接受也不将私有视图变为可执行。
 * 6. 非活动异常清单可显式检查中断参考；状态键销毁旧结果，不把入口标志当作执行退出证明。
 * 7. 具备任务排空凭据的已发布批次可显式恢复私有刷新，完成后重读状态，不运行旧任务。
 * 不显示控制路径/内部错误码，不从参考材料推断源码已经应用。
 */
import type { LocalOverlayInfo, Session } from "../shared/types";
import { LocalFileReview } from "./LocalFileReview";
import { LocalPublicationRecovery } from "./LocalPublicationRecovery";
import { LocalPrivateRefresh } from "./LocalPrivateRefresh";
import s from "./app.module.css";

export function LocalOverlayStatus({
  info,
  sessionId,
  onCreated,
  onUpdated,
}: {
  info: LocalOverlayInfo;
  sessionId: string;
  onCreated: (session: Session) => void;
  onUpdated: () => void;
}) {
  let message = "修改保留在本对话的私有视图，尚无源码发布记录。";
  if (
    info.state === "failed" ||
    info.state === "unavailable" ||
    info.interruptedReview
  ) {
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
    <div className={s.localOverlayStatus}>
      <p role="status">{message}</p>
      {info.fileReviewSupported !== false && info.privateRefreshRecovery && (
        <LocalPrivateRefresh
          key={`${sessionId}:${info.epoch}`}
          sessionId={sessionId}
          onUpdated={onUpdated}
        />
      )}
      {info.fileReviewSupported !== false && info.publicationRecovery && (
        <LocalPublicationRecovery
          key={`${sessionId}:${info.epoch}:${info.state}`}
          sessionId={sessionId}
        />
      )}
      {info.resolution && (
        <p>
          本对话从最新主目录开始，
          {info.resolution.paths
            ? `所选 ${info.resolution.paths.length} 个文件`
            : info.resolution.path}{" "}
          的旧修改仅作为参考，尚未自动应用；原对话仍保留。
          {info.resolution.state === "interrupted" &&
            "参考来自中断执行，可能包含部分写入，须重新核对当前源码。"}
        </p>
      )}
      {info.fileReviewSupported === false && (
        <p>
          当前平台暂不提供文件检查和异常恢复面板。正常结束的对话可继续任务读取私有修改；异常现场保持保留。
        </p>
      )}
      {info.fileReviewSupported !== false &&
        (info.state === "ready" || info.interruptedReview) && (
          <LocalFileReview
            key={`${sessionId}:${info.epoch}:${info.state}:${Boolean(info.interruptedReview)}`}
            sessionId={sessionId}
            onCreated={onCreated}
            interrupted={info.interruptedReview}
          />
        )}
    </div>
  );
}
