# Interface review status

标尺动效修复（2026-11-01）：依据 emil-design-eng 的短时反馈、稳定布局和可中断过渡原则，保留刻度/端点结构。计数与完整角标修复继续保留。

| Before | After | Why |
| --- | --- | --- |
| 端点同时动画 left/top/width/height | 固定16px端点，仅透明度与transform过渡，约200ms | 避免几何跳动和两个大圆重叠 |
| 展开/收起切换滚动裁切，影响定位 | 动画全程保持容器状态，结束后再隐藏；尺轴跟随真实触发中心 | 避免滚动条与边界约束导致位移 |
| 指针越界立即关闭 | 12px容错和160ms缓冲，拖动期间不关闭 | 方便从按钮移向刻度与百分比 |
| 键盘、触摸共用悬停逻辑 | 键盘直接响应，触摸点击切换，支持减少动态效果 | 避免触摸双触发和键盘延迟 |

浏览器验证桌面/320px展开、缩放键盘调整、Esc关闭、尺轴对齐与控制台无error；自动化新增快速重开取消旧定时器、退出布局保留、视口约束和键盘即时关闭回归。没有做逐帧性能基准或真机触摸验收。

角标计数修复（2026-11-01）：添加按钮原来使用累计导入文件数，改为当前保留的记录数，包含附件/待核对，多页同票一条、重复排除不计、筛选不影响总数；title/无障碍名称明确统计口径。角标从负偏移移入按钮边界，工具栏增加顶部留白，修复滚动容器裁切。新增回归覆盖多页、附件、重复文件、筛选、删页/撤销和清空。浏览器实测1280px角标28×28完整位于76px添加按钮内，加号36×36完整显示。

侧边工具与卡片操作打磨（2026-11-01）：根据用户截图放大桌面添加按钮至76px、其余侧边工具至64px，预留120px独立工具区域。卡片选择/替换改为同排等宽的44px图标文字按钮，状态标签降低视觉重量；操作区采用卡片缩放的完整逆补偿，在60%–160%保持44px点击高度，避免放大后按钮堆叠。520px以下网格改为单列。浏览器验证1440/1280桌面及320手机宽度、60%/160%缩放、列表/网格和选择状态更新，按钮同排、无页面横向溢出，图标在状态更新后保留；39项功能回归及语法/空白检查通过。

最终浏览器验收（2026-11-01）：用户明确要求检查遮挡/占位并重新部署，已实际检查 1440×1000、1280×800、1024×600、390×844 和 320×740 视口。修复首次点击票面被选择栏展开打断；手机工具横排、取消右侧预留空白，恢复完整内容宽度；导出区两列加整行主操作；核对窗口重新分配票面/表单空间，保存按钮并排固定，左转文字可见；比例尺弹层加视口边界约束。实测首次点击打开预览、左右切页、左转、搜索弹层、跨筛选隐藏选择、列表/网格切换及比例尺展开/关闭；320px 页面与核对控件无越界，保存/翻页按钮中心命中真实控件，工具栏与票面不相交。核对侧栏在390px可见滚动区域由约170px增至约330px；控制台未捕获 error。39项本机功能检查及语法/空白检查通过。未测试真实手机软键盘、全部浏览器或Tauri原生窗口。

交互审查与修复（2026-11-01）：搜索/筛选保留有效选择，提示隐藏选择数量并提供取消和显示全部入口；当前全选仅作用于可见票据；卡片增加触控可用的文字选择按钮。核对窗口按打开时的筛选范围导航，保留同票全部页面和保存后的核对范围，关闭时将焦点交还列表。预览工具独立成行，表单/保存操作改为单列，排序工具可换行且显示标签；移除旧 nowrap!important 约束。39 项本机功能回归、语法/空白检查通过。检测器降级为正则：未评估计算样式/对比度；尺轴边框和旧拖动条纹为非卡片的检测误报，搜索/比例尺的局部布局动画为已有保留设计，支持 reduced-motion。尚未进行浏览器 UI/键盘/触屏或 Tauri 实机验收，不提供未经实测的视觉评分。

功能与重点层级调整（2026-11-01）：增加默认收起的功能说明及文字“继续添加票据”入口；合计突出显示，含待核对金额时明确标注；“待核对”统计可直接筛选。整批/选中 PDF、整票替换/单页删除、确认保存/下一票使用不同名称，卡片显示文字状态。依据 ui-ux-pro-max 与 ui-styling 的通用可读性、语义控件与主次操作原则；本地主次按钮检索未得到适配条目，未采用无关结果。15 项相关功能回归、语法和空白检查通过；未运行浏览器 UI 或 Tauri 界面验收。

按钮尺寸调整（2026-11-01）：导出/清空/核对保存等主要文字按钮提高至 52px，卡片操作 48px 并补偿 80% 等缩小比例；工具栏、搜索和右侧图标同步加大，移动端导出分行。仅修改样式和缓存版本，未进行运行时界面验证；待用户核对窄屏与桌面显示。

后续授权（2026-11-01）：用户允许本机识别回归并要求 GitHub Pages 发布。已增加清空本批、精简说明并增强识别，35 项本机功能回归通过；20 份带文字 PDF / 44 页得到 34 张计费票据、5592.66 元。仍未进行浏览器 UI 或 Tauri 运行验证；历史“禁止测试/发布”记录仅说明当时范围，当前授权见 AGENTS.md。

2026-11-01 仓库审核与替换操作：基于最新 `ac3a3ac`，增加整张发票替换、失败保留、重复检查、撤销和本地恢复；修复追加排序、CSV 并发与对话框反馈，并调整核对表单可读性。按 AGENTS.md 仅做静态代码复核和语法检查，没有运行测试、UI 检测器、浏览器或 Tauri 交互验证。详细范围与手动验收项目见 `review-20261101.md`。

final result: blocked

The user explicitly requested no further tests or interface verification and will test the app personally. The final hover magnifier and removal of reorder buttons have not been visually verified. Packaging is not a substitute for runtime verification.

Visual references supplied in this chat:
- Empty import state: codex-clipboard-a0bcde86-7f1e-44c5-a9cc-75b4cb5c2ce1.png.
- Imported cards and side add button: codex-clipboard-94a6d562-21b4-42f7-979c-67087fc4a407.png.
- Controls to remove: codex-clipboard-7cb3b5be-cf6c-4351-8af6-ce528320c498.png.

Intentional adaptations: blue-green theme, local file input, invoice-specific fields, date/company sorting, one-row icon toolbar, header exports, multiple selection, and hover magnifier.

No external publication or remote Git push is authorized.

Latest change: free card drag preview and animated insertion gaps. No tests or UI verification were performed after this change, as explicitly requested.

Final follow-ups: conditional checkboxes, read-only sequence markers, hidden card page counts and invoice numbers, hover-copy total, and automatic date sorting on import. All remain untested at the user's request.

2026-11-01 follow-ups: consolidated the preview title into the filename in the review sidebar; moved an editable page position between zoom and rotation; enlarged previous/next controls; buffered page rendering and adjusted wheel navigation; added manual-confirmation thumbnail badges; emphasized selection tools on the left; remembered card scale independently of invoice drafts; put grid dates and companies on one line; removed the detail-count hint and the empty selection strip. No tests or UI verification were run. Web and packaged Tauri behavior remain for the user to verify separately.

Added a selection-toolbar action to merge only selected records into a PDF using the current export order, preserving retained pages and attachments. It shares the existing browser/native save path; missing selected pages are reported before export. No tests or UI verification were run, as requested.

Added three independent right-rail toggles for card filenames, company names and invoice dates in both layouts. Hidden states are saved immediately as local preferences and restored independently of drafts. Review warnings remain visible even when all three fields are hidden. No tests or UI verification were run, as requested.

The field toggles use circular buttons and three distinct hand-authored SVG line icons (document title, company building, calendar), with hover labels and diagonal slashes for hidden fields.

Extended thumbnail delete controls with a transparent pseudo-element 10px beyond each edge, keeping their visible size, icons, position and hover appearance. Touch targeting remains unverified under the user's no-test/no-UI-verification instruction.

Moved the scale control to the end of the right tool rail, below all three visibility buttons, including keyboard order. Reduced both expanded morph endpoints from 24px to 16px with transparent hit padding. No tests or UI verification were run, as requested.

Replaced the scale button's expand-arrow icon with a custom SVG vertical ruler, matching the other controls' line weight and color. No tests or UI verification were run.

Aligned the ruler axis, endpoints and a separate visual thumb; the native transparent range retains keyboard/pointer behavior and maps its 142px center travel to the tick positions. Added centered thumb enlargement on hover, drag and keyboard focus. Search now morphs left from its fixed 12px rounded rectangular button into a field with the same radius, with outside-click, focus and Escape dismissal. Unified control radii through tokens (12px controls, 16px groups, 4px insets, circular right-rail tools) and aligned toolbar heights. Based on the supplied screenshots; no tests or runtime UI verification were run.

Changed thumbnail deletion to a stationary 44px hit box with a centered 24px visible face. Hover enlargement applies only to the visible face within the existing page bounds, avoiding the scrolling overflow from scaling the expanded hit region. Genuine multipage horizontal scrolling remains available. No tests or runtime UI verification were run.
