# 桌面便签待办

跨 Windows 与 Android 的多便签待办工作台。项目包含桌面客户端、华为兼容的 Android 客户端、Firebase 身份认证与 Firestore 同步规则，以及供中国网络环境下移动端使用的 Cloudflare 中转。

## 主要功能

- 多便签桌面、便签组、拖动排序与边缘收纳
- 清单、看板、月/周日历、无截止日期任务
- 子任务、备注、搜索、归档、回收站与数据备份
- 全局快速记录、系统托盘、通知动作和主题设置
- 邮箱注册验证、登录、找回密码和跨设备自动同步
- Android 触摸交互、本地通知与华为手机兼容

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/` | Electron 桌面端源码 |
| `mobile/www/` | Android 端 Web UI 与移动桥接代码 |
| `mobile/android/` | Capacitor Android 工程 |
| `firebase-relay/` | Cloudflare Pages Function 中转服务 |
| `firestore.rules` | Firestore 用户隔离与字段限制规则 |
| `firestore.indexes.json` | Firestore 索引配置 |

构建产物、依赖目录、测试截图、用户数据和真实服务配置均不会提交到 Git。

## 环境要求

- Node.js 20 或更高版本
- Windows 10/11（桌面安装包构建）
- Android Studio、JDK 21 与 Android SDK 35（Android 构建）
- Firebase 项目（仅跨设备登录与同步需要）
- Cloudflare 账号（仅部署移动端中转时需要）

## Firebase 配置

桌面端可以在没有 Firebase 配置时离线启动。若需要账号与同步功能：

1. 在 Firebase 控制台创建 Web 应用，并启用“电子邮件地址/密码”登录。
2. 创建 Firestore 数据库。
3. 将 `src/firebase-config.example.json` 复制为 `src/firebase-config.json`。
4. 填入 Firebase Web 应用的 `apiKey`、`authDomain`、`projectId` 和 `appId` 等字段。
5. 将 `.firebaserc.example` 复制为 `.firebaserc`，填入项目 ID。
6. 安装 Firebase CLI 后执行 `firebase deploy --only firestore` 发布规则和索引。

`src/firebase-config.json`、`.firebaserc`、令牌和用户数据属于本机配置，不应提交到仓库。Firebase Web API Key 本身不是服务端密钥，但仍建议在 Google Cloud 控制台限制允许使用的 API。

## Windows 桌面端

```powershell
npm ci
npm run check
npm start
```

生成安装版和便携版：

```powershell
npm run dist
```

产物位于 `dist/`。用户数据、窗口状态和备份保存在 Electron 用户数据目录，不会写入程序安装目录。

## Android / 华为手机端

先确保 Android SDK 可通过 `ANDROID_HOME` 环境变量找到，或在 `mobile/android/local.properties` 中写入本机 SDK 路径，例如 `sdk.dir=C:\\Users\\你的用户名\\AppData\\Local\\Android\\Sdk`。这个本机路径文件不会提交到 Git。

```powershell
cd mobile
npm ci
npm run check
npm run apk
```

`npm run apk` 会先执行 Capacitor 同步，再生成 Debug APK。产物通常位于：

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

APK 未上架应用商店时，手机需要允许从浏览器或文件管理器安装未知来源应用。正式分发前应另外配置私有签名文件，并生成 Release APK 或 AAB；签名文件不要提交到 GitHub。

## Cloudflare 中转

移动端默认通过限定路由的中转访问 Firebase。部署命令：

```powershell
cd firebase-relay
npx --yes wrangler@4 pages deploy public --project-name speraymer-note-sync-relay
```

若更换中转域名或 Firebase 项目，需要同步修改 `mobile/www/mobile-bridge.js` 中的公开客户端配置，以及 `mobile/www/index.html` 的 Content Security Policy。

## 源码完整性检查

以下内容应存在于一次干净克隆中：

- 根目录和 `mobile/` 下的 `package-lock.json`
- Electron 的 `src/main.js`、`src/preload.js`、`src/renderer.js`
- `mobile/www/` 全部前端文件
- Android Gradle Wrapper 与 `mobile/android/` 工程
- Firestore 规则、索引和 Cloudflare 中转源码

以下内容按设计不进入源码仓库：`node_modules/`、`dist/`、`outputs/`、APK/EXE、Firebase 本地配置、Android SDK 路径、签名文件、令牌以及用户便签数据。

## 版本

- Windows：2.3.0
- Android：1.1.2

## 许可证

MIT，详见 `LICENSE`。
