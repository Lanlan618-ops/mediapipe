# mediapipe 1.0

四个视觉 demo 的归档，以及一个把四组形态合并在一起的实时手势粒子体验。包含两段全息影像、两个可旋转的 3D 花束场景，和一个全屏摄像头手势页面。

## 目录

```
mediapipe1.0/
├── index.html                      # 总览页
├── start.command                   # 本地预览启动脚本
├── 01_man_flower_hologram/         # 1. 男人手捧鲜花全息 3D
│   ├── man_flower_hologram.mp4
│   └── man_flower_hologram_poster.png
├── 02_rose_3d/                     # 2. 3D 建模玫瑰花（九朵粉玫瑰）
│   ├── index.html                  # 可旋转场景
│   ├── app.js
│   ├── assets/                     # Three.js、GLB、字体等
│   └── renders/                    # 预览渲染
├── 03_rapeseed_3d/                 # 3. 3D 建模油菜花
│   ├── index.html                  # 可旋转场景
│   ├── viewer/                     # Three.js 查看器
│   ├── model/                      # OBJ / GLB / MTL
│   └── renders/                    # 预览渲染
├── 04_couple_hologram/             # 4. 男后背抱女生 3D 全息
│   ├── couple_hologram_gold.mp4
│   └── couple_hologram_gold_poster.png
└── 05_gesture_particles/           # 合并体验：摄像头 + 手势粒子
    ├── index.html
    ├── app.js                      # 单场景四形态粒子 + 手势状态机
    ├── style.css
    └── assets/                     # 目标图 / Three.js / MediaPipe
```

## 预览

双击 `start.command`。脚本会在 `4180` 端口启动本地服务器并打开总览页。

也可以手动运行：

```bash
cd mediapipe1.0
python3 -m http.server 4180
```

然后访问 <http://127.0.0.1:4180/>。

> `02_rose_3d` 与 `03_rapeseed_3d` 使用 Three.js / WebGL，必须通过本地服务器访问，不能直接双击 HTML。全息影像为静音循环 MP4。

## 说明

- **01**：男人与红玫瑰花束的全息影像，人物置于透视白色线框立方体内。
- **02**：九朵粉玫瑰、绿色附着叶片、收拢花茎；可旋转查看，页面内提供 GLB 下载。
- **03**：透明直筒玻璃花瓶中的油菜花，带清水与玻璃折射；提供 OBJ 与 GLB 下载。
- **04**：双人影像被暖金线框立方体完整框住，底部环形扫描、纯黑背景与微细星光；8 秒循环。
- **05**：把四组视觉资产合成同一套双手手势体验：左手抬起张开时，全息立方体出现在掌上并跟随移动；右手张开让内容爆散成高密度粒子，握拳瞬间聚合为新模型并切换到“红玫瑰 → 男人拿花 → 黄色油菜花 → 后背拥抱”的下一形态。玫瑰与油菜花使用原 3D 模型随立方体旋转，人像保持正面；两朵花下方带 “The Boundary of Letting Go / Where Souls Agree” 英文艺术字；右手带实时全息骨架。打开 <http://127.0.0.1:4180/05_gesture_particles/>；`?debug=1` 显示双手关键点与追踪诊断。
- 全息影像保留画面内容；04 中人物肤色与衣物颜色保持原图真实色调，金色只用于线框与扫描光效。
