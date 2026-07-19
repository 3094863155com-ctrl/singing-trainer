# 视唱练耳

一个基于 Web 的视唱练耳训练工具，帮助用户进行唱名（solfege）听音与视唱练习。

## 项目结构

```
singing-trainer/
├── singing_trainer.html     # 主页面 - 唱歌训练器（GitHub Pages 根目录）
├── harmony_melody.js        # 和声与旋律生成逻辑
├── vexflow.js               # VexFlow 音乐记谱库
├── 音源/                    # 唱名音源文件（MP3）
│   ├── do_4.mp3
│   ├── re_4.mp3
│   ├── mi_4.mp3
│   ├── fa_4.mp3
│   ├── sol_4.mp3
│   ├── la_4.mp3
│   └── si_4.mp3
│   ... (含升降记号变体)
└── README.md
```

## 功能特性

- **唱歌训练器**：基于唱名的视唱练习，支持乐谱显示与播放
- **音源播放**：使用真实录制的唱名音源（do/re/mi/fa/sol/la/si 及升降记号）
- **乐谱渲染**：基于 VexFlow 实现五线谱记谱
- **和声旋律**：支持自动生成和声与旋律用于练习

## 使用方法

### 在线访问（推荐）

直接在浏览器中打开 GitHub Pages 部署地址：

**https://3094863155com-ctrl.github.io/singing-trainer/singing_trainer.html**

手机端直接复制以上链接到浏览器即可使用（建议使用 Chrome 或 Safari）。

### 本地运行

克隆仓库后直接在浏览器中打开 `singing_trainer.html`：

```bash
# 克隆仓库
git clone https://github.com/3094863155com-ctrl/singing-trainer.git

# 进入项目
cd singing-trainer

# 用浏览器打开主页面
open singing_trainer.html
```

> **注意**：本地 file:// 协议下可能无法加载人声采样（CORS 限制），建议使用 HTTP 服务器运行：
> ```bash
> python3 -m http.server 8000
> # 然后访问 http://localhost:8000/singing_trainer.html
> ```

## 技术栈

- **HTML5** - 页面结构
- **JavaScript** - 交互逻辑与音频处理
- **VexFlow** - 音乐记谱渲染
- **Web Audio API** - 音频播放

## License

This project is open source and available under the MIT License.
