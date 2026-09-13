# 用模拟容器和临时应用包检查 refresh_image，不连接真实 Docker 或模型。
# 属于手动 unittest 套件。
#
# 1. 提供匹配的 base_commit 和应用包，检查新镜像、包哈希、上传内容、校验命令和容器清理。
# 2. 返回不匹配的 base_commit，检查抛出错误、不保存新镜像，并且仍然清理容器。
#
# 只在用户要求时运行。这些模拟用例不替代真实镜像的安装验证。

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
