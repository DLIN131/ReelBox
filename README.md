# ReelBox

Windows 桌面版影片瀏覽器：瀏覽、播放、下載。

## 功能

- 最新影片、分類、作者、標籤瀏覽，內容類型篩選與排序，往下捲自動載入
- 搜尋關鍵字，或直接貼上影片網址開啟
- 內建播放器：360p～4K 畫質切換、記住慣用畫質、從上次看到的地方繼續
- 滑鼠停在縮圖上播放預覽
- 下載：選擇畫質、同時下載兩部、可暫停 / 續傳（關掉程式再開也能接著下載）、下載完成可直接在程式內播放
- 收藏、觀看紀錄、追蹤分類 / 作者
- 程式內自動更新，更新紀錄（點版本號或「設定 → 更新紀錄」）

## 快捷鍵（影片頁）

| 按鍵 | 功能 |
| --- | --- |
| 空白 / K | 播放 / 暫停 |
| ← / → | 倒退 / 快轉 5 秒 |
| J / L | 倒退 / 快轉 10 秒 |
| ↑ / ↓ | 音量 |
| F | 全螢幕 |
| M | 靜音 |
| Esc / Alt+← / 滑鼠側鍵 | 返回 |

## 下載

[ReelBox-Windows.zip（最新版）](https://github.com/DLIN131/ReelBox/releases/latest/download/ReelBox-Windows.zip)，解壓縮後執行 `ReelBox.exe`。
請放在可寫入的資料夾（例如桌面或文件），程式內更新才能覆蓋檔案。

## 開發

```bash
npm install
npm start          # 開發模式
node pack.js dist  # 打包 Windows 版
```

推到 `main` 會由 GitHub Actions 自動打包並發布新版本（v1.0.<run_number>），commit 訊息就是更新紀錄。
