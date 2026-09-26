#!/bin/bash
# 人机协同首登一键脚本：起虚拟屏 + VNC(仅本机回环) + noVNC，再跑 assisted-login。
# 用法：bash bin/assisted-login.sh <账号id>
# 用户侧：SSH 隧道 -L 6080:127.0.0.1:6080 后浏览器开 http://localhost:6080/vnc.html
set -e
ACC_ID="${1:?用法: assisted-login.sh <账号id>}"
VNC_PASS_FILE=/opt/rhnode/.vncpass
LOG_DIR=/tmp/aissist
DISP=:98   # 独立显示号，避开 xvfb-run -a 默认的 :99（曾有残留孤儿导致鉴权冲突）
mkdir -p "$LOG_DIR"

if [ ! -f "$VNC_PASS_FILE" ]; then
  VNC_PW=$(tr -dc 'a-z0-9' < /dev/urandom | head -c 10)
  x11vnc -storepasswd "$VNC_PW" "$VNC_PASS_FILE" >/dev/null 2>&1
  chmod 600 "$VNC_PASS_FILE"
  echo "VNC_PASS=$VNC_PW （首次生成，请记下）"
fi

# 1) 虚拟屏（幂等：已在跑就复用；故意不 kill，跨次登录复用同一屏）
if xdpyinfo -display $DISP >/dev/null 2>&1; then
  echo "Xvfb $DISP 已在运行，复用"
else
  rm -f /tmp/.X98-lock /tmp/.X11-unix/X98 2>/dev/null || true
  nohup Xvfb $DISP -screen 0 1440x900x24 -nolisten tcp > "$LOG_DIR/xvfb.log" 2>&1 &
  sleep 1
  xdpyinfo -display $DISP >/dev/null 2>&1 || { echo "Xvfb 启动失败，看 $LOG_DIR/xvfb.log"; exit 1; }
  echo "Xvfb $DISP 已起"
fi

# 2) x11vnc（仅回环 + VNC 密码）与 noVNC（仅回环 6080）
x11vnc -display $DISP -rfbport 5900 -rfbauth "$VNC_PASS_FILE" -forever -shared \
  -localhost -quiet > "$LOG_DIR/x11vnc.log" 2>&1 &
X11VNC=$!
websockify 127.0.0.1:6080 localhost:5900 --web /usr/share/novnc \
  > "$LOG_DIR/websockify.log" 2>&1 &
WS=$!
sleep 1
kill -0 $X11VNC 2>/dev/null || { echo "x11vnc 启动失败，看 $LOG_DIR/x11vnc.log"; exit 1; }
kill -0 $WS 2>/dev/null || { echo "websockify 启动失败，看 $LOG_DIR/websockify.log"; exit 1; }
echo "noVNC 就绪：http://localhost:6080/vnc.html （需 SSH 隧道 -L 6080:127.0.0.1:6080）"

trap 'kill $X11VNC $WS 2>/dev/null' EXIT
DISPLAY=$DISP node /opt/rhnode/selftest/aistudio-assisted-login.js "$ACC_ID"
RC=$?
cat "$LOG_DIR/report.json" 2>/dev/null || true
exit $RC
