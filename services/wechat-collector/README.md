# CampusOS 公众号采集同步进程

读取本机 WeRSS API 与微信 MP Tools 的本地导出，把已完成的文章转换成可阅读 HTML，再同步到 CampusOS。程序只在本机运行，不要求把桌面程序暴露到公网。

Python 3.12 标准库即可运行，不依赖新的云服务或媒体存储。

## 配置

复制 `config.example.json` 为本地配置，填入 WeRSS、MP Tools 导出目录和 CampusOS 管理员签发的限源凭据。凭据和同步状态只放在本地数据目录，不要提交到 Git。

## 运行

```powershell
python services/wechat-collector/collector.py --config "./data/CampusOS_collector/config.json"
python services/wechat-collector/collector.py --config "./data/CampusOS_collector/config.json" --watch
```

`--watch` 每 60 秒同步已完成的导出；中断后依靠 SQLite 回执续传。同一请求重试不会产生第二篇文章。更新会替换当前正文，不保存正文历史。没有本地正文、没有原文时间或来源不在范围内时跳过，并在 `last-sync.json` 记录原因；不会用文件修改时间或下载时间代替原文发布时间。

Windows 常驻启动/停止入口是本目录的 `start.ps1` / `stop.ps1`；`install-shortcuts.ps1` 可在 MP Tools 目录生成双击入口。启动只连接 CampusOS，并带单进程锁；不是开机自启任务。日志不包含凭据或正文。

## 格式与空间

新下载默认输出 `reading.html`，同时兼容旧 `metadata.json` / `data.json`。HTML 保留原文图片地址、背景、文字、标题、列表、表格和链接；图片由浏览器按原地址加载，不另存媒体副本。

服务端会移除脚本、事件处理器、表单和不安全链接，正文通过禁止脚本的独立 HTML 框架展示。正文上限 1.5 MB。公众号身份必须与信息源范围一致，不会自动合并同名或改名账号。

## 同步边界

只新增或更新，不根据本地目录或文件消失删除云端文章。目录不存在只记录 `EXPORT_UNAVAILABLE`；云端采集端点也拒绝删除。没有完成原文在线复查时，不能声称已经自动发现原文更新或删除。
