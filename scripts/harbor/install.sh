#!/usr/bin/env bash
set -euo pipefail

# A private prefix leaves the task's system Node installation unchanged.
prefix=/opt/codeatelier
node_version=24.19.0
mkdir -p "$prefix/runtime/bin" "$prefix/app"

if command -v node >/dev/null && command -v npm >/dev/null && [ "$(node --version)" = "v${node_version}" ]; then
    # Reuse an exact-version task runtime to avoid downloading it for every trial.
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
