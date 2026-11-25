# 死亡圣棋 · 联机版

## 启动

本项目使用 Node.js 内置模块，无需安装依赖。

```bash
node server.js
```

然后打开：

```
http://127.0.0.1:8787/
```

可用环境变量修改端口：

```bash
PORT=9000 node server.js
```

## 已实现

- 用户名/密码注册与登录（密码经 scrypt 加盐哈希）
- 用户名在数据库中唯一；比较时忽略大小写与全角/半角差异
- 登录会话保留在浏览器本地
- 随机匹配，按“段位 + 积分 + 连胜”优先匹配，等待时间越长范围越大
- 服务端权威的 5×5 双人对局：
  - 经典模式与移形换影模式
  - 移形换影使用 7 枚基础箭头，起终点、距离消耗与终点限制完整同步
  - 圣器共鸣计分
  - 棋子耗尽、认输、超时判负
  - 任意棋的“棋子耗尽 / 目标格已满”两种判罚
- 联机不使用姓名输入，直接使用登录用户名投入火焰杯
- 移形换影在首次达到正式棋手时永久解锁，掉段不会重新封印
- 移形换影模式的所有积分加减为经典模式结果的 ×2
- 双方各自视角结算：
  - 胜者：WIN
  - 败者：LOSE，蓝色火焰背景
  - 平局：紫色火焰、TWIN STARS
- 等级与积分（仅联机生效）：
  - 学徒、见习棋手、正式棋手、中阶棋手、高阶棋手、传奇棋手、规则棋手、真理棋手、始祖棋手
  - 每胜一局 +10 起；三连胜起按 1.2 倍递增；十连胜起按 1.5 倍递增
  - 学徒、见习失败不扣分；正式至传奇失败 -5；规则至始祖失败 -10
  - 掉段保护：第一次跌破 0 分时扣至 0 并保留段位，第二次才掉段
- 离线模式（一人、两人、自定义房间）保持不变，不影响联机积分

## 上线：GitHub Pages 前端 + Render 后端

GitHub Pages 只能托管静态文件，**不能运行 `server.js`**。本仓库已经准备好方案一：前端由 GitHub Pages 托管，Node 服务由 Render 托管并挂载持久磁盘。

> 实际云端部署需要你的 GitHub 与 Render 账号。代码和一键配置已准备好，但无法代替你登录第三方平台点击部署。

### 第 1 步：推送到 GitHub

把本目录推送到 GitHub 仓库的 `main` 分支，确保包含：

- `index.html`
- `online-config.js`
- `server.js`
- `package.json`
- `render.yaml`
- `.github/workflows/pages.yml`

`.gitignore` 已排除 `online-data.json`，账号数据不会提交到仓库。

### 第 2 步：在 Render 部署后端

1. 登录 Render，选择 **New → Blueprint**。
2. 连接你的 GitHub 仓库，Render 会读取 `render.yaml`。
3. 将 `render.yaml` 中的 `ALLOWED_ORIGIN` 改成你的 GitHub Pages 源：
   ```yaml
   value: https://你的用户名.github.io
   ```
   如果使用自定义域名，则填自定义域名的源，例如 `https://chess.example.com`。
4. 部署。
   - 配置使用 `starter` 套餐并挂载 1GB 持久磁盘 `/var/data`。
   - 账号数据写入 `/var/data/online-data.json`，服务重启不会丢失。
   - 免费实例没有持久磁盘，账号会随重启丢失；若只想试玩可自行改为 free 并接受数据重置。
5. 部署完成后访问：
   ```
   https://你的服务.onrender.com/api/health
   ```
   应返回：
   ```json
   {"ok":true,"service":"deathly-hallows-chess"}
   ```

### 第 3 步：配置 GitHub Pages

1. 打开 GitHub 仓库 **Settings → Pages**。
2. **Build and deployment → Source** 选择 **GitHub Actions**。
3. 打开 **Settings → Secrets and variables → Actions → Variables**，新增：
   - 名称：`ONLINE_API_URL`
   - 值：`https://你的服务.onrender.com`（不要带结尾斜杠）
4. 打开 **Actions**，运行 `Deploy frontend to GitHub Pages`，或向 `main` 推送一次。
5. 工作流会：
   - 检查 `ONLINE_API_URL` 是否存在
   - 把地址写入 `online-config.js`
   - 只把 `index.html` 与配置发布到 Pages
6. 打开 Pages 地址：
   ```
   https://你的用户名.github.io/仓库名/
   ```

前端会自动读取注入的后端地址，不再请求 GitHub Pages 自身的 `/api/...`。

### 常见问题

- **联机请求失败 / 404**：`ONLINE_API_URL` 没配置，或 Pages 仍使用分支部署而不是 GitHub Actions。
- **CORS 错误**：Render 的 `ALLOWED_ORIGIN` 必须与浏览器里的前端源完全一致，包括 `https://`，不要带路径。
- **混合内容拦截**：GitHub Pages 是 HTTPS，后端必须也是 HTTPS。
- **重启后账号消失**：后端没挂持久磁盘，或 `DATA_DIR` 未指向磁盘挂载目录。
- **Pages 404**：确认 Pages 源选择了 GitHub Actions，并等工作流完成。
- **后端冷启动慢**：Render 免费/低配实例首次请求可能需要几十秒，等待健康检查通过后再试。

### 不使用 GitHub Pages 的替代方案

也可以把整个仓库直接部署到 Render/Railway/Fly.io/VPS；Node 服务本身会同时提供页面与 API，此时不需要配置 `ONLINE_API_URL`。

## 数据

`online-data.json` 会在首次注册时自动创建，保存账号、积分、连胜和会话。
删除该文件可清空所有账号数据。

## 说明

- 当前联机对局采用经典 / 移形换影两种 5×5 双人规则，并支持联机悔棋（双方各 3 次，二次确认 + 对方同意）。本地离线模式仍保留完整的一人、两人、自定义、移形换影与悔棋。
- 这是可直接运行的本地服务器版本。正式上线时需要 HTTPS、域名、反向代理、数据库与更完整的限流/风控。
