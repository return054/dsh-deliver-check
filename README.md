# dsh-deliver-check

TODO: 一句话说明插件做什么（收录审查硬要求：描述与代码一致——声称几个工具就得有几个）。

## 安装

```bash
# npm（推荐）
dsh plugin --profile <你的profile> add dsh-deliver-check

# GitHub 仓库（纯 JS 免构建授权）
dsh plugin --profile <你的profile> add github:<owner>/<repo>

# tarball
dsh plugin --profile <你的profile> add ./dsh-deliver-check-0.1.0.tgz
```

## 使用

对模型说：`Use the deliver_check tool ...`

## 发布

推 tag 即自动发布（需先配置 NPM_TOKEN，见 .github/workflows/publish.yml）：

```bash
npm version patch && git push --follow-tags
```
