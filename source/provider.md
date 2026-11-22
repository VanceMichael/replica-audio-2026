# 触点读数与播放器

`GET /touch/sessions` 给面板、安装代、扫描号、块清单和是否封口。 `GET /touch/blocks?scan=值&block=值` 返回 TP1 起始的二进制，后随地址、手势、小端坐标 uint16、重复序号 uint16。手势 1 点击，2 划动。相同扫描号的块可以重传，但扫描号不能跨代使用。
`GET /player/active` 按语种列活动配置与面板代。 `POST /player/stage` 为语种写入备用组合，接 `locale`、`generation` 和配置指纹。 `POST /player/activate` 根据备用票据切换；409 意味现场代与备用票据不符。
演练 `mounted` 为首次扫描未结束，`reversed` 表示翻向后新扫描，`new-sound` 模拟受安装代限制后的播放器读回。

扫描台 A/B 代与安装信息相同，现场地址 1 用两个手势，安装 B 的坐标可区分两个实际纹样。另一展馆的 Q 仍为独立面板，播放器按语种工作；yue 表示粤语。
