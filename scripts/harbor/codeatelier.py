"""Installed-agent adapter for Harbor 0.23.0; never runs task commands on the host."""

import hashlib
import json
import os
import shlex
import tempfile
from pathlib import Path, PurePosixPath

from pydantic import Field, field_validator
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class CodeAtelierOptions(InstalledAgentOptions):
    bundle_path: str = ".local/harbor/codeatelier.tar.gz"
    workspace: str | None = None
    max_total_tokens: int = Field(default=500000, ge=1, le=100000000)
    max_model_calls: int = Field(default=60, ge=1, le=1000)
    max_steps: int = Field(default=30, ge=1, le=100)
    timeout_ms: int = Field(default=600000, ge=100, le=3600000)
    allow_workspace_commands: bool = False

    @field_validator("workspace")
    @classmethod
    def absolute_workspace(cls, value: str | None) -> str | None:
        if value is not None and (
            not value.startswith("/") or ".." in PurePosixPath(value).parts
        ):
            raise ValueError("workspace must be an absolute container path")
        return value


class CodeAtelierAgent(BaseInstalledAgent):
    options_model = CodeAtelierOptions

    @staticmethod
    def name() -> str:
        return "codeatelier"

    def version(self) -> str:
        return "0.1.0-harbor"

    async def install(self, environment: BaseEnvironment) -> None:
        bundle = Path(self.options.bundle_path).resolve()
        if not bundle.is_file():
            raise ValueError("Prepare the CodeAtelier runtime bundle first")
        self._bundle_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
        await environment.upload_file(bundle, "/installed-agent/codeatelier.tar.gz")
        await environment.upload_file(
            Path(__file__).with_name("install.sh"),
            "/installed-agent/codeatelier-install.sh",
        )
        await self.exec_as_root(
            environment, "bash /installed-agent/codeatelier-install.sh"
        )

    def command(self, workspace: str, prompt: str, output: str) -> str:
        args = [
            "/opt/codeatelier/runtime/bin/node",
            "/opt/codeatelier/app/dist/server/evaluation/main.js",
            "--workspace",
            workspace,
            "--output",
            output,
            "--prompt-file",
            prompt,
            "--max-total-tokens",
            str(self.options.max_total_tokens),
            "--max-model-calls",
            str(self.options.max_model_calls),
            "--max-steps",
            str(self.options.max_steps),
            "--timeout-ms",
            str(self.options.timeout_ms),
        ]
        if self.options.allow_workspace_commands:
            args.append("--allow-workspace-commands")
        return shlex.join(args)

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        key = self._extra_env.get("CODEATELIER_API_KEY") or os.environ.get(
            "CODEATELIER_API_KEY"
        )
        if not key:
            raise ValueError("Set CODEATELIER_API_KEY in the Harbor host environment")
        model = self.model_name or os.environ.get(
            "CODEATELIER_MODEL", "codex/gpt-5.6-luna"
        )
        base_url = self._extra_env.get("CODEATELIER_BASE_URL") or os.environ.get(
            "CODEATELIER_BASE_URL", "http://jp.harryshan.com:4141/v1"
        )
        workspace = self.options.workspace
        if workspace is None:
            result = await self.exec_as_agent(environment, "pwd -P")
            workspace = (result.stdout or "").strip()
        if not workspace.startswith("/") or "\n" in workspace:
            raise ValueError("Could not determine container workspace")

        output = str(self.environment_logs_dir / "codeatelier")
        prompt = str(self.environment_logs_dir / "codeatelier-prompt.txt")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "codeatelier-build.json").write_text(
            json.dumps(
                {
                    "bundleSha256": getattr(self, "_bundle_hash", None),
                    "harborVersion": "0.23.0",
                }
            ),
            encoding="utf-8",
        )
        await self.exec_as_agent(
            environment, f"mkdir -p {shlex.quote(str(self.environment_logs_dir))}"
        )
        with tempfile.TemporaryDirectory(prefix="codeatelier-prompt-") as temporary:
            local_prompt = Path(temporary) / "prompt.txt"
            local_prompt.write_text(instruction, encoding="utf-8", newline="\n")
            await environment.upload_file(local_prompt, prompt)
        # Uploaded files may be root-owned, while the task may select an unprivileged user.
        await self.exec_as_root(environment, f"chmod 644 {shlex.quote(prompt)}")
        env = {
            "CODEATELIER_API_KEY": key,
            "CODEATELIER_BASE_URL": base_url,
            "CODEATELIER_MODEL": model,
        }
        try:
            await self.exec_as_agent(
                environment,
                self.command(workspace, prompt, output),
                env=env,
                timeout_sec=(self.options.timeout_ms + 999) // 1000 + 15,
            )
        finally:
            # Backfill usage even on a non-zero agent exit. Harbor also syncs the full logs.
            local_output = self.logs_dir / "codeatelier"
            local_output.mkdir(exist_ok=True)
            for filename in ("usage.json", "report.json"):
                try:
                    await environment.download_file(
                        f"{output}/{filename}", local_output / filename
                    )
                except Exception:
                    self.logger.warning(
                        "CodeAtelier artifact unavailable: %s", filename
                    )
            self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        context.metadata = dict(context.metadata or {})
        usage_file = self.logs_dir / "codeatelier/usage.json"
        if not usage_file.is_file():
            context.metadata["codeatelierUsageComplete"] = False
            return
        usage = json.loads(usage_file.read_text(encoding="utf-8"))
        complete = usage["calls"] > 0 and usage["unmeasuredCalls"] == 0
        context.metadata["codeatelierUsageComplete"] = complete
        context.metadata["codeatelierReportedUsage"] = usage
        # Partial totals remain in metadata; never present them as full billing usage.
        context.n_input_tokens = usage["inputTokens"] if complete else None
        context.n_output_tokens = usage["outputTokens"] if complete else None
        context.n_cache_tokens = (
            usage["cachedInputTokens"]
            if complete and usage["cachedUsageComplete"]
            else None
        )
        report_file = self.logs_dir / "codeatelier/report.json"
        if report_file.is_file():
            context.metadata["codeatelierReport"] = json.loads(
                report_file.read_text(encoding="utf-8")
            )
