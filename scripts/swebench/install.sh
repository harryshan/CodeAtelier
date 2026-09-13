#!/usr/bin/env bash
# 为手动评测容器安装 CodeAtelier，把运行时和应用放在 /opt/codeatelier。
#
# 1. 创建 runtime 和 app 目录；已有 Node 版本完全匹配时直接复用。
# 2. 否则下载对应架构的 Node，核对校验和后解包。
# 3. 解开 /installed-agent 下的应用包，设置 PATH 并安装指定版本的 pnpm。
# 4. 按锁文件安装生产依赖，跳过依赖脚本，设置读取权限并打印 Node 版本。
#
# 会联网和安装软件，只用于评测容器。独立安装目录避免替换题目原有的 Node。

set -euo pipefail

# 单独安装，避免覆盖题目原有的 Node。
prefix=/opt/codeatelier
node_version=24.19.0
mkdir -p "$prefix/runtime/bin" "$prefix/app"

if command -v node >/dev/null && command -v npm >/dev/null && [ "$(node --version)" = "v${node_version}" ]; then
    # 版本完全一致就直接复用，避免每题都重新下载。
    ln -sf "$(command -v node)" "$prefix/runtime/bin/node"
else
    if ! command -v curl >/dev/null || ! command -v xz >/dev/null; then
        command -v apt-get >/dev/null || {
            echo 'CodeAtelier setup requires curl, xz and tar (or apt-get).' >&2
            exit 1
        }
        apt-get update -qq
        apt-get install -y --no-install-recommends curl ca-certificates xz-utils
    fi

    case "$(uname -m)" in
        x86_64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) echo 'Unsupported Linux architecture' >&2; exit 1 ;;
    esac

    archive="node-v${node_version}-linux-${arch}.tar.xz"
    cd "$prefix"
    curl --fail --location --retry 2 "https://nodejs.org/dist/v${node_version}/${archive}" -o "$archive"
    curl --fail --location --retry 2 "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o SHASUMS256.txt
    grep " ${archive}$" SHASUMS256.txt | sha256sum --check --strict
    tar -xJf "$archive" -C runtime --strip-components=1
fi

tar -xzf /installed-agent/codeatelier.tar.gz -C "$prefix/app"
export PATH="$prefix/runtime/bin:$PATH"
cd "$prefix/app"
npm install --global --prefix "$prefix/runtime" pnpm@11.22.0
pnpm install --prod --frozen-lockfile --ignore-scripts
chmod -R a+rX "$prefix"
node --version
