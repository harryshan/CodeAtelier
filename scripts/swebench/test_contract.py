# 检查评测的数据读取、提示生成、打包和容器清理，使用临时目录和模拟容器。
# 属于手动 unittest 套件，不调用真实模型、Docker 或数据下载。
#
# 1. 模拟镜像失败、取消和使用已准备镜像，检查状态记录与清理。
# 2. 检查子集 ID 唯一、提示只含题目信息，并拒绝重复题目。
# 3. 创建构建文件和不应打包的敏感文件，检查归档只包含允许的内容。
#
# 只在用户要求时运行，不加入默认测试。

"""Manual-only contract tests; no model calls, Docker or dataset downloads."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dataset import load_manifest, prompt_for
from prepare import prepare
from predict import run_trial


class ContractTests(unittest.TestCase):
    def test_image_failure_is_recorded_without_a_patch(self):
        client = Mock()
        client.images.pull.side_effect = RuntimeError("private error detail")
        module = SimpleNamespace(
            make_test_spec=lambda *a, **k: SimpleNamespace(
                instance_image_key="test-image"
            )
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("sys.modules", {"swebench.harness.test_spec.test_spec": module}),
        ):
            output = Path(directory)
            result = run_trial(
                client, {"instance_id": "a__b-1"}, output, Path("unused"), None
            )
            report = json.loads((output / "trial.json").read_text())
            self.assertEqual(result["model_patch"], "")
            self.assertEqual(report["status"], "setup_failed")
            self.assertNotIn("private error detail", json.dumps(report))

    def test_cancel_removes_current_container(self):
        client = Mock()
        client.images.pull.return_value.id = "image-id"
        container = client.containers.create.return_value
        container.start.side_effect = KeyboardInterrupt
        container.get_archive.side_effect = RuntimeError("no artifacts")
        module = SimpleNamespace(
            make_test_spec=lambda *a, **k: SimpleNamespace(
                instance_image_key="test-image"
            )
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("sys.modules", {"swebench.harness.test_spec.test_spec": module}),
        ):
            output = Path(directory)
            with self.assertRaises(KeyboardInterrupt):
                run_trial(
                    client, {"instance_id": "a__b-1"}, output, Path("unused"), None
                )
            self.assertEqual(
                json.loads((output / "trial.json").read_text())["status"], "cancelled"
            )
            container.remove.assert_called_once_with(force=True)

    def test_prepared_image_bypasses_registry_and_spec_download(self):
        client = Mock()
        client.images.get.return_value.id = "prepared-id"
        client.containers.create.return_value.start.side_effect = KeyboardInterrupt
        client.containers.create.return_value.get_archive.side_effect = RuntimeError(
            "no artifacts"
        )
        module = SimpleNamespace(
            make_test_spec=Mock(
                side_effect=AssertionError("Unexpected network spec lookup")
            )
        )
        args = SimpleNamespace(
            prepared_images={
                "a__b-1": {
                    "preparedImage": "local-ready",
                    "preparedImageId": "prepared-id",
                    "baseImageId": "base-id",
                }
            }
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("sys.modules", {"swebench.harness.test_spec.test_spec": module}),
        ):
            with self.assertRaises(KeyboardInterrupt):
                run_trial(
                    client,
                    {"instance_id": "a__b-1"},
                    Path(directory),
                    Path("unused"),
                    args,
                )
            report = json.loads((Path(directory) / "trial.json").read_text())
            self.assertEqual(report["imageId"], "prepared-id")
            client.images.pull.assert_not_called()

    def test_manifest_has_twenty_unique_instances(self):
        manifest = load_manifest(Path("evals/swebench/subset.json"))
        self.assertEqual(len(manifest["instance_ids"]), 20)

    def test_prompt_contains_only_issue(self):
        prompt = prompt_for(
            {
                "problem_statement": "Fix addition",
                "patch": "GOLD_SECRET",
                "test_patch": "TEST_SECRET",
                "hints_text": "HINT_SECRET",
            }
        )
        self.assertIn("Fix addition", prompt)
        for secret in ("GOLD_SECRET", "TEST_SECRET", "HINT_SECRET"):
            self.assertNotIn(secret, prompt)

    def test_duplicate_instances_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "subset.json"
            path.write_text(
                json.dumps({"revision": "a" * 40, "instance_ids": ["a__b-1", "a__b-1"]})
            )
            with self.assertRaises(ValueError):
                load_manifest(path)

    def test_bundle_excludes_credentials_and_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "dist/server/evaluation"
            runtime.mkdir(parents=True)
            (runtime / "main.js").write_text("export {};")
            for name in ("package.json", "pnpm-lock.yaml", ".env", "history.sqlite"):
                (root / name).write_text("private")
            manifest = prepare(root, root / "bundle.tar.gz")
            self.assertEqual(
                set(manifest["files"]),
                {"package.json", "pnpm-lock.yaml", "dist/server/evaluation/main.js"},
            )


if __name__ == "__main__":
    unittest.main()
