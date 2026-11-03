# Interface review status

购买方识别与导出前核对（2026-11-03）：增加购买方名称、税号及来源，按票面标签或标准发票左右栏区分购销方，OCR 仅补缺失字段且不混入不同购买方税号；乘客姓名及文件名不作公司抬头依据。核对面板可修改，草稿保留手动结果，旧草稿可从保留票面文字补充；CSV/复制新增两列。整批/选中 PDF 和 CSV 下载前显示本次范围的抬头检查，可输入预期名称与税号，忽略空格/全半角差异比对，标注缺失、个人及不一致项目，点击直接查看原票。多抬头/税号批次有提示，附件不做计费抬头要求；用户确认后可继续导出，不改变排序或总额。50 项本机回归通过（新增4项涵盖购销分离、OCR、旧草稿/人工修正、选中导出范围），语法和空白检查通过。真实样票13份/36页、35条记录，本机识别23条购买方及税号，27条计费合计5004.08；不含公司抬头的行程凭证保持缺失状态。浏览器核验旧草稿两票三页165.45的抬头恢复、预期公司匹配/不匹配、跳转原票/重置、确认后实际PDF与CSV下载；导出PDF3页、CSV11列2行合计165.45且抬头字段完整。320×740检查窗列表约286px独立滚动，确认按钮在视口内，无横向溢出或控制台error。网页已测；未进行Tauri运行、真机触控或全部扫描件OCR端到端验证。未上传私有票据或本机报告。

明细查看与按需复制（2026-11-02）：将明细入口改为原生模态表格，保留整批 CSV 下载；支持选择文字、勾选行复制及复制全部，使用制表符分隔便于粘贴。预览、复制与 CSV 共享同一批次快照和计入规则，多页发票仅一条，附件不累加，所选合计仅包含所选计费金额。剪贴板拒绝时在模态内回退传统复制，实际失败明确反馈。追加导入关闭旧明细窗口，避免旧快照被误认为新批次。新增 3 项回归覆盖顺序/金额/快照、部分复制和剪贴板失败；合计 46 项通过，语法和空白检查通过。浏览器验证本机两张三页票据合计165.45、勾选/全选/复制反馈、实际 CSV 下载、Escape 关闭、320px 窄屏横向滚动和按钮可达，无控制台error；修复历史全局手机样式隐藏新表头的问题。仅验证网页端，未运行 Tauri 或真机触屏；未验证各外部表格软件的自动数据类型转换。

滚动条/底纹协调（2026-11-02）：按用户要求将票据与顶部工具滚动条移至左侧，直接子内容维持ltr，不更改卡片排序。底纹从全窗口定位改为工作区右下角定位，收至桌面30vmin/最大360px、手机42vw/最大200px，仍为青绿渐变完整图形。统一透明滚动轨道、圆角滑块和悬停加深，Chromium使用10px槽/4px可见滑块且隐藏箭头，其他引擎回退标准thin。实测1440桌面及320手机列表滚动时window.scrollY保持0、顶部不动，左侧clientLeft10px，右下底纹距右22px，无页面横向溢出和控制台error。未验证所有浏览器或真机触摸。

固定信息栏（2026-11-02）：导入后使用视口高度工作区，顶部信息/筛选/操作区域与独立票据滚动区分离；小窗口上顶部区域限制最大高度并可独立滚动，不挤掉票据区域。拖动边缘自动滚动、缩略图IntersectionObserver同步使用新滚动容器。浏览器实测320×740票据区约289px，列表scrollTop233px时顶部位置80px和window.scrollY0保持不变；1440桌面票据区约698px。43项功能回归、语法与空白检查通过。

最终配色澄清（2026-11-02）：用户明确指定青绿渐变，替换上一轮灰绿单色为140度青蓝 #0c9eaf → 青绿 #00aa9a → 绿色 #4aba7b；保持图形蒙版，无文字、完整轮廓及响应式右下角定位。底纹透明度桌面16%、手机11%，保留边缘留白和不拦截点击。

底纹色彩打磨（2026-11-02）：使用原图透明轮廓蒙版着色为灰绿 #397e74，替代直接叠加高饱和青色。桌面透明度10%、尺寸34vmin/最大400px；手机透明度6.5%、48vw/最大240px。边距调整为桌面20–32px自适应、手机20px；保留完整轮廓、无文字、multiply混合及不拦截点击。浏览器核对1440×1000蒙版加载与颜色，图形340px、边距28px；未改变票据数据、识别、缩放或导出逻辑。

品牌底纹（2026-11-02）：使用用户提供的透明PNG，原图左侧653px正方形区域为完整图形，653–786px为透明分隔；CSS仅绘制左侧图形区域，文字不进入可见背景范围。右下角固定，桌面36vmin/最大420px、手机52vw/最大260px，保持1:1比例并约束视口及安全区。6.5%透明度、multiply混合，不拦截指针、不占文档布局；打印时隐藏，不修改PDF导出。浏览器实测1440×1000为360px完整图形，320×740为166.4px完整图形，16px边距，无横向溢出、无控制台error。

标尺动效修复（2026-11-01）：依据 emil-design-eng 的短时反馈、稳定布局和可中断过渡原则，保留刻度/端点结构。计数与完整角标修复继续保留。

补充：浏览器复查发现悬停展开后首次点击可能落在上端点，误改成160%；增加指针离开触发区前的端点保护，键盘端点操作保持正常。实测80%时首次鼠标点击展开仍保持80%，并新增回归。

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
