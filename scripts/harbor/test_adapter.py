"""Adapter contract tests against the pinned Harbor package (no model or Docker)."""

import json
import shlex
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from harbor.models.agent.context import AgentContext
from scripts.harbor.codeatelier import CodeAtelierAgent, CodeAtelierOptions
from scripts.harbor.prepare import prepare


class FakeEnvironment:
    default_user = "agent"

    def __init__(self, return_code=0, incomplete=False):
        self.commands = []
        self.uploads = {}
        self.return_code = return_code
        self.incomplete = incomplete

    async def exec(self, command, **kwargs):
        self.commands.append((command, kwargs))
        if command.endswith("pwd -P"):
            return SimpleNamespace(return_code=0, stdout="/app\n", stderr="")
        code = self.return_code if "evaluation/main.js" in command else 0
        return SimpleNamespace(return_code=code, stdout="", stderr="")

    async def upload_file(self, source_path, target_path):
        self.uploads[target_path] = Path(source_path).read_bytes()

    async def download_file(self, source_path, target_path):
        if source_path.endswith("usage.json"):
            value = {
                "calls": 2,
                "measuredCalls": 1 if self.incomplete else 2,
                "unmeasuredCalls": 1 if self.incomplete else 0,
                "inputTokens": 200,
                "outputTokens": 30,
                "totalTokens": 230,
                "cachedInputTokens": 50,
                "cachedUsageComplete": True,
            }
        else:
            value = {"stopReason": "failed" if self.return_code else "completed"}
        Path(target_path).write_text(json.dumps(value), encoding="utf-8")


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_prompt_is_uploaded_not_interpolated_and_usage_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = CodeAtelierAgent(
                logs_dir=Path(temporary), model_name="codex/test", max_total_tokens=1234
            )
            environment = FakeEnvironment()
            context = AgentContext()
            prompt = "Fix `x`; $(touch unexpected)\n中文 'quoted'"
            with patch.dict("os.environ", {"CODEATELIER_API_KEY": "test-only-key"}):
                await agent.run(prompt, environment, context)

            command, kwargs = next(
                item for item in environment.commands if "evaluation/main.js" in item[0]
            )
            self.assertNotIn(prompt, command)
            self.assertNotIn("test-only-key", command)
            self.assertEqual(kwargs["env"]["CODEATELIER_API_KEY"], "test-only-key")
            self.assertEqual(kwargs["env"]["CODEATELIER_MODEL"], "codex/test")
            self.assertIn(prompt.encode(), environment.uploads.values())
            self.assertIn("1234", shlex.split(command))
            self.assertEqual(context.n_input_tokens, 200)
            self.assertEqual(context.n_output_tokens, 30)
            self.assertEqual(context.n_cache_tokens, 50)
            self.assertIsNone(context.cost_usd)

    async def test_failed_execution_preserves_partial_usage_without_claiming_totals(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            agent = CodeAtelierAgent(logs_dir=Path(temporary))
            context = AgentContext()
            with patch.dict("os.environ", {"CODEATELIER_API_KEY": "test-only-key"}):
                with self.assertRaises(RuntimeError):
                    await agent.run(
                        "task", FakeEnvironment(return_code=1, incomplete=True), context
                    )
            self.assertIsNone(context.n_input_tokens)
            self.assertFalse(context.metadata["codeatelierUsageComplete"])
            self.assertEqual(
                context.metadata["codeatelierReportedUsage"]["inputTokens"], 200
            )

    def test_arguments_are_quoted_and_options_reject_invalid_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = CodeAtelierAgent(
                logs_dir=Path(temporary), allow_workspace_commands=True
            )
            workspace = "/app/space 'quote' $(not-a-command)"
            args = shlex.split(agent.command(workspace, "/tmp/prompt", "/logs/output"))
            self.assertEqual(args[args.index("--workspace") + 1], workspace)
            self.assertIn("--allow-workspace-commands", args)
        with self.assertRaises(ValueError):
            CodeAtelierOptions(max_total_tokens=-1)
        with self.assertRaises(ValueError):
            CodeAtelierOptions(workspace="../host")

    def test_bundle_uses_allowlisted_files_and_hashes(self):
        import tarfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "dist/server/evaluation"
            runtime.mkdir(parents=True)
            (runtime / "main.js").write_text("// runtime\n")
            (runtime / "main.js.map").write_text("private source")
            (root / "package.json").write_text("{}")
            (root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'")
            (root / ".env").write_text("SECRET=do-not-copy")
            output = root / "bundle.tar.gz"
            metadata = prepare(root, output)
            with tarfile.open(output) as archive:
                self.assertEqual(
                    set(archive.getnames()),
                    {
                        "package.json",
                        "pnpm-lock.yaml",
                        "dist/server/evaluation/main.js",
                    },
                )
            self.assertEqual(len(metadata["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
