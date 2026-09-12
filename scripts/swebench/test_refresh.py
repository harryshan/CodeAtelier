# 文件作用：手动验证镜像刷新时的新代码安装、校验失败清理和数据完整性边界。
#
# 使用场景与输入输出：
# 独立手动 unittest 回归，使用 Mock 容器和临时 bundle 测试 refresh_image，不连接真实 Docker 或模型。
#
# 代码结构与阅读顺序：
# 1. 成功场景提供正确 base_commit 与 bundle，检查返回新镜像及包哈希、上传内容和校验命令，并确认容器被清理。
# 2. 错误场景返回不匹配的 base_commit，断言抛出错误、不提交镜像且仍清理容器。
#
# 维护注意事项：
# 仅覆盖这些替身场景，不能当作真实镜像安装验收；不纳入默认测试，也不在本次注释任务中执行。

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from refresh_run import refresh_image


class RefreshTests(unittest.TestCase):
    def test_new_bundle_verified_before_image_is_published(self):
        client = Mock()
        container = client.containers.create.return_value
        container.commit.return_value.id = "new-image"
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "bundle.tar.gz"
            bundle.write_bytes(b"new-code")
            with (
                patch("refresh_run.execute", return_value=b"base\n") as execute,
                patch("refresh_run.upload") as upload,
            ):
                result = refresh_image(
                    client,
                    {"preparedImageId": "old-image"},
                    {"instance_id": "a__b-1", "base_commit": "base"},
                    bundle,
                    {"sha256": "new-digest", "files": {"dist/server/main.js": "abc"}},
                    "run1",
                )
            self.assertEqual(result["preparedImageId"], "new-image")
            self.assertEqual(result["bundleSha256"], "new-digest")
            self.assertEqual(upload.call_args_list[0].args[2], b"new-code")
            self.assertIn(
                "sha256sum", [call.args[1][0] for call in execute.call_args_list]
            )
            container.remove.assert_called_once_with(force=True)

    def test_bad_base_never_publishes_image_and_cleans_container(self):
        client = Mock()
        container = client.containers.create.return_value
        with patch("refresh_run.execute", return_value=b"wrong\n"):
            with self.assertRaisesRegex(ValueError, "base_commit"):
                refresh_image(
                    client,
                    {"preparedImageId": "old-image"},
                    {"base_commit": "base"},
                    Path("unused"),
                    {},
                    "run1",
                )
        container.commit.assert_not_called()
        container.remove.assert_called_once_with(force=True)
