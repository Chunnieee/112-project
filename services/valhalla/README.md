# 本機 Valhalla（Windows）

使用官方 `pyvalhalla==3.9.1` Windows 套件內的原生 `valhalla_service.exe`，提供 `http://localhost:8002`。不需要 Docker、WSL 或 API 金鑰。路線由 Valhalla C++ 引擎計算。

## 日常啟動

- 雙擊專案根目錄的 `start-navigation.cmd`：啟動 Valhalla，再啟動導航網站（3000）。
- 網站已開啟時，雙擊 `start-valhalla.cmd`：只啟動路由服務。已啟動時不會重複開啟。
- 雙擊 `stop-valhalla.cmd`：停止由本專案啟動的 Valhalla，保留路網。
- 檢查狀態：<http://localhost:8002/status>。這是 API，沒有地圖首頁；地圖仍在 <http://localhost:3000>。

服務在背景執行，僅監聽 `127.0.0.1:8002`，沒有新增 Windows 開機自動啟動項目。重新開機後請再次執行啟動檔。紀錄在 `logs/service.stdout.log`、`logs/service.stderr.log`；停止腳本會核對程序路徑與啟動時間，避免誤停其他程序。

## 資料與範圍

臺灣路網來自 [Geofabrik Taiwan](https://download.geofabrik.de/asia/taiwan.html) 的 OpenStreetMap PBF，下載後核對供應方 MD5，再建立行政資料、道路圖與转彎限制。版本與校驗值記錄於 `data/build-info.json`。

支援本專案的 `auto`、`motor_scooter`、`pedestrian`，最多主路線加兩條替代路線。候選數依起終點及道路條件而異。路網建置後，路線計算可在本機進行；地址搜尋、底圖、TDX 與安全分析的 Overpass 等服務仍可能需要網路。

本次未建置高程、即時交通、公車班表及時區邊界資料庫；目前專案送出的請求沒有指定出發日期時間。若要擴充依日期、時段限制或大眾運輸規劃，應先補齊相關資料。Geofabrik 區域截取不含所有國家／行政邊界成員，建置日誌會提示部分邊界無法使用；不可將路由結果視為道路法規完整性的驗證。

資料授權：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，ODbL 1.0；資料截取由 Geofabrik 提供。Valhalla 套件保留官方授權資訊。

## 在另一台 Windows 電腦重建

需要 Python 3.12 以上（64 位元）。在專案根目錄的 PowerShell 執行：

```powershell
python -m venv services/valhalla/.venv
.\services\valhalla\.venv\Scripts\python.exe -m pip install --only-binary=:all: -r services/valhalla/requirements.txt
.\services\valhalla\.venv\Scripts\python.exe services/valhalla/build_data.py
.\start-valhalla.cmd
```

此電腦首次建置使用 Codex 附帶的 Python 建立獨立環境。日常啟動直接使用套件中的原生程式；不需要啟動 Python HTTP 轉接服務。原始下載檔、路網、環境及日誌均已加入 `.gitignore`。

更新路網前先停止 Valhalla，再執行 `build_data.py`；更新完成後重新啟動。請勿在服務使用路網時覆寫路網。此腳本會重新建置，不會只更新個別道路。

官方說明：[Python 套件及原生工具](https://valhalla.github.io/valhalla/bindings/python/)。
