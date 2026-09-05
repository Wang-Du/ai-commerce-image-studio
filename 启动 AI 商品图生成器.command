#!/bin/zsh

set -u
project_dir="${0:A:h}"
cd "$project_dir" || exit 1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "尚未安装 Node.js。"
  echo "请先安装 Node.js 20 或更高版本，然后重新双击本文件。"
  echo "官网：https://nodejs.org/"
  read "? 按回车键关闭…"
  exit 1
fi

if curl -fsS http://127.0.0.1:4317/api/health 2>/dev/null | grep -q 'ai-commerce-image-studio'; then
  open http://127.0.0.1:4317/
  exit 0
fi

if [[ ! -d node_modules ]]; then
  echo "首次启动，正在安装运行依赖…"
  npm ci || exit 1
fi

echo "正在启动 AI 商品图生成器…"
npm start &
server_pid=$!

for attempt in {1..40}; do
  if curl -fsS http://127.0.0.1:4317/api/health 2>/dev/null | grep -q 'ai-commerce-image-studio'; then
    open http://127.0.0.1:4317/
    wait "$server_pid"
    exit $?
  fi
  sleep 0.25
done

echo "启动失败。请确认 4317 端口没有被其他程序占用。"
kill "$server_pid" 2>/dev/null
exit 1
