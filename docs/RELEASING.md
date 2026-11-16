# 维护者发布步骤

1. 提升 `package.json` 的程序版本号，并同步 `package-lock.json`。每次功能发布使用更高的三段数字版本；同一程序版本改发另一个标签不会被视为升级。
2. 更新 README 的版本、下载链接与 `docs/releases/` 说明，运行 `npm test`。
3. 在 Windows x64 运行 `npm run build:windows`，用新安装包验证升级与资料保留，再将 `FATIO_INSTALLED_EXE` 指向安装版执行 `npm run test:updates`。该测试使用独立资料，不使用真实账号。
4. 用 `Get-FileHash` 为安装包生成 `SHA256SUMS.txt`；上传前确认公开提交和安装包不包含账号资料、Cookie、密钥与日常草稿。
5. 将本版源码提交并推送 GitHub，使用对应源码提交创建 Release，上传 `Fatio-Setup-版本号-x64.exe` 与校验文件。开发者预览版勾选 pre-release。
6. 从公开版本页核对安装包大小与 GitHub SHA-256，确认 README 下载链接可用。安装包上传完整后，支持更新检测的客户端将在下次检查时收到提示。

示例（用实际版本号替换）：

```powershell
gh release create v1.12.3-dev.1 .\release\Fatio-Setup-1.12.3-x64.exe .\release\SHA256SUMS.txt --repo zhizhiniao/Fatio --target main --title '发条 Fatio 1.12.3 · 开发者预览版' --notes-file .\docs\releases\v1.12.3-dev.1.md --prerelease
```

检测读取本仓库公开 Release 列表，仅接受匹配版本的已上传 Windows x64 安装包；草稿、缺少安装包、其他仓库地址和低于本机的版本不会提供升级入口。检测包含预览版，并在界面标明。

1.12.2 及更早版本不具备更新检测能力，需从仓库手动安装一次 1.12.3 或更新版本。默认安装目录与数据身份应保持兼容，程序目录调整不能替代资料保留验收。

依据：[GitHub Releases API](https://docs.github.com/en/rest/releases/releases)、[Electron net.fetch](https://www.electronjs.org/docs/latest/api/net)、[Electron 外部链接安全](https://www.electronjs.org/docs/latest/tutorial/security)。
