# 文件作用：手动验证镜像刷新时的新代码安装、校验失败清理和数据完整性边界。
# 代码结构：使用容器替身覆盖成功镜像记录与失败不提交；不连接 Docker 或模型，仅独立手动执行。

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
