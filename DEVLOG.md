### 1. 如何关闭通过安装脚本运行的后台服务？

由于你之前通过 install.sh 或 onboard 命令安装了后台守护进程（Daemon），它会一直占用 18789 端口，导致你本地开发时报 EADDRINUSE（端口被占用）错误。

关闭它的方法：

如果你是在 macOS 上：

```Bash

# 停止当前正在运行的后台服务
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
# （可选）如果你不想它开机自启了，可以把这个文件删掉
# rm ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

如果你是在 Linux 上：

```Bash
systemctl --user stop openclaw-gateway
# （可选）取消开机自启
# systemctl --user disable openclaw-gateway
```

或者，如果你本地的旧版 CLI 还能用，你可以直接运行：

```Bash

moltbot daemon stop
# 或
openclaw daemon stop
```
