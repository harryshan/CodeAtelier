#!/usr/bin/env bash
set -euo pipefail
printf 'export const add = (a, b) => a + b;\n' > /app/math.mjs
