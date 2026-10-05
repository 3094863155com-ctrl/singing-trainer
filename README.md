# 视唱练耳

一个基于 Web 的视唱练耳训练工具，帮助用户进行唱名（solfege）听音与视唱练习。

## 项目结构

```
singing-trainer/
├── index.html               # 主页面（GitHub Pages 首页）
├── index active.html        # 旧地址，自动跳转到 index.html
├── harmony_melody.js        # 和声与旋律生成逻辑
├── chord_recognition.js     # 和弦听辨（和弦进行生成 / 配声 / 三种播放）
├── vexflow.js               # VexFlow 音乐记谱库
├── .nojekyll                # 让 GitHub Pages 跳过 Jekyll 处理
├── 音源/                    # 唱名音源文件（MP3）
│   ├── do_4.mp3
│   ├── re_4.mp3
│   ├── mi_4.mp3
│   ├── fa_4.mp3
│   ├── sol_4.mp3
│   ├── la_4.mp3
│   ├── si_4.mp3
│   │   ... (含升降记号变体)
│   └── 和弦钢琴/            # 爱丽丝钢琴采样 piano_36.mp3 ~ piano_84.mp3（49 个）
└── README.md
```

## 功能特性

- **唱歌训练器**：基于唱名的视唱练习，支持乐谱显示与播放
- **和弦听辨**：随机调性的和弦连接，纯播放不判分
  - 配声模式：三和弦（单行谱 · 3 音）/ 四部和声（大谱表 · 4 音）
  - 三种播放方式：柱式、分解和弦（一拍四音）、单音（每小节最低音长音）
  - 罗马数字级数标注、转位开关、6₄ 和弦开关、速度与连奏可调
  - 点谱面上的任意小节，可从该小节开始播放（当前小节高亮跟随）
- **音源播放**：使用真实录制的唱名音源（do/re/mi/fa/sol/la/si 及升降记号）
- **乐谱渲染**：基于 VexFlow 实现五线谱记谱
- **和声旋律**：支持自动生成和声与旋律用于练习

## 使用方法

### 在线访问（推荐）

直接在浏览器中打开 GitHub Pages 部署地址：

**https://3094863155com-ctrl.github.io/singing-trainer/**

手机端直接复制以上链接到浏览器即可使用（建议使用 Chrome 或 Safari）。

### 本地运行

克隆仓库后在浏览器中打开 `index.html`：

```bash
# 克隆仓库
git clone https://github.com/3094863155com-ctrl/singing-trainer.git

# 进入项目
cd singing-trainer

# 用浏览器打开主页面
open index.html
```

> **注意**：本地 file:// 协议下可能无法加载音频采样（CORS 限制），建议使用 HTTP 服务器运行：
> ```bash
> python3 -m http.server 8000
> # 然后访问 http://localhost:8000/index.html
> ```

## 技术栈

- **HTML5** - 页面结构
- **JavaScript** - 交互逻辑与音频处理
- **VexFlow** - 音乐记谱渲染
- **Web Audio API** - 音频播放

## License

This project is open source and available under the MIT License.
