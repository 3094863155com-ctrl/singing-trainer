# 视唱练耳 · 局域网社交 — 部署手册（手动版）

> 目标读者：第一次搭前后端的人。每一步都写了「怎么算成功」。
> 本目录的文件：`server.js`（后端程序）、`package.json`（依赖清单）、
> `shichanglianer.service`（开机自启配置）、`nginx-snippet.conf`（Nginx 反代片段）。

---

## 一、API 契约（前后端各自的"任务书"）

所有接口都是 JSON；请求失败返回 `{ "ok": false, "error": "..." }`，HTTP 状态码 400/404。
留言内容与昵称里不会有 HTML —— 前端渲染一律用 `textContent`，没有注入风险。

### GET /api/ping — 健康检查
前端每过一会儿调一次，通 = 已连上局域网服务器。
```json
{ "ok": true, "name": "视唱练耳社交", "time": 1730000000000 }
```

### POST /api/register — 注册 / 同步设备身份
首次访问时前端生成 `deviceId`（UUID）、昵称（随机池）、颜色，一并带来。
重复调用 = 用最新资料覆盖（改名后补报也走它，幂等）。
```json
// 请求
{ "deviceId": "8f3c…", "name": "赋格的管风琴", "color": "#6366f1" }
// 返回
{ "ok": true, "device": { "id": "8f3c…", "name": "赋格的管风琴", "color": "#6366f1" } }
```

### POST /api/profile — 只改昵称（设备须已注册）
```json
// 请求
{ "deviceId": "8f3c…", "name": "夜曲的竖琴" }
// 返回
{ "ok": true, "device": { "id": "8f3c…", "name": "夜曲的竖琴", "color": "#6366f1" } }
```

### GET /api/messages — 拉留言（增量）
- 首次：`GET /api/messages` → 最近 100 条（正序）。
- 之后：`GET /api/messages?after=42` → 只返回 id > 42 的新留言（正序）。
```json
{ "ok": true, "serverTime": 1730000000000,
  "messages": [
    { "id": 43, "clientId": "uuid", "deviceId": "8f3c…",
      "name": "赋格的管风琴", "color": "#6366f1",
      "text": "今天降二号和弦老听成四级", "ts": 1729999900000 }
  ] }
```

### POST /api/messages — 发留言
`clientId` 由前端生成（UUID）。**同一条消息离线重传多次也只会存一条**（数据库按 clientId 去重）。
```json
// 请求
{ "deviceId": "8f3c…", "clientId": "uuid", "text": "今天降二号和弦老听成四级" }
// 返回
{ "ok": true, "id": 43, "duplicate": false }
```

---

## 二、手动部署清单（在 Ubuntu 虚拟机里做）

前置检查：`node -v` ≥ 20（没有就先装 Node 20 LTS，NodeSource 脚本两条命令）。

### 第 0 步：Mac 端上传后端文件夹
```bash
scp -r backend ubuntu@192.168.1.10:/home/ubuntu/shichanglianer-backend
```

### 第 1 步：装依赖（虚拟机里）
```bash
sudo apt install -y build-essential python3   # better-sqlite3 编译要用，装过就跳过
cd ~/shichanglianer-backend
npm install
```
✅ 验证：目录里多了 `node_modules`，没有红色 error（WARN 无所谓）。

### 第 2 步：手动跑一次，看它活着
```bash
node server.js
```
✅ 验证：看到「社交后端已启动：http://127.0.0.1:3000」。
另开一个终端：`curl http://127.0.0.1:3000/api/ping` → 返回 `{"ok":true,...}`。
确认完 `Ctrl+C` 停掉（后面交给 systemd）。

### 第 3 步：交给 systemd（开机自启 + 崩了自动拉起）
```bash
sudo cp shichanglianer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shichanglianer
systemctl status shichanglianer
```
✅ 验证：status 显示 `active (running)`（绿色）；`curl http://127.0.0.1:3000/api/ping` 仍通。

### 第 4 步：Nginx 加反代
编辑 `/etc/nginx/sites-available/default`，在 `server { }` 里、现有 `location /` 旁边，
按 `nginx-snippet.conf` 的内容加一段 `location /api/ { ... }`，然后：
```bash
sudo nginx -t && sudo systemctl reload nginx
```
✅ 验证：`curl http://192.168.1.10/api/ping` → 通。**这一步通了，前后端就算打通了。**

### 第 5 步：上传前端（Mac 端；以后每轮改完前端都走这条）
```bash
rsync -av --delete index.html social.js chord_recognition.js vexflow.js 音源 ubuntu@192.168.1.10:/var/www/shichanglianer/
```
（第一次会提示权限不足的话，先在虚拟机执行
 `sudo chown -R ubuntu:ubuntu /var/www/shichanglianer`，以后就不用 sudo 了。）

### 第 6 步：手机验证
连家里 Wi-Fi，Safari 打开 `http://192.168.1.10` → 顶栏第三个图标进社交页 →
状态徽标应显示「已连接」→ 发一条留言 → 另一台设备打开同网址能看到。

---

## 三、日常排查（出问题按顺序看）

1. `systemctl status shichanglianer` — 后端活着吗？
2. `journalctl -u shichanglianer -n 50` — 后端最近 50 行日志（报错都在这）。
3. `curl http://127.0.0.1:3000/api/ping` — 绕过 Nginx 直连后端通不通？
   - 通而 `192.168.1.10/api/ping` 不通 → Nginx 反代段没写对（回第 4 步）。
4. 数据库就是一个文件 `data.sqlite`：备份=复制它；想清空留言=停服务、删文件、再启动。
