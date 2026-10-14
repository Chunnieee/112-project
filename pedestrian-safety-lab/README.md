# Pedestrian Safety Lab

這是從「Risk-Aware Multi-modal Navigation」畢業專題(112-project)拆出來的**獨立專案**,只保留行人安全評分功能跟它的三個資料來源(事故 / 路燈 / 便利商店)。目的是讓你可以不用開整個導航系統、不用管 OSRM/TDX/地理編碼,就能專心處理「這三種資料到底準不準」這件事。

跟 112-project 的關係:`pedestrianSafety/` 整個資料夾是直接複製過來、完全沒改邏輯,所以這裡的評分公式、資料結構都跟主專案一致;只有 `server.js`、`audit.js`、`public/` 是這個獨立專案新寫的,主專案裡沒有。如果之後要把這裡做的資料改進帶回主專案,只要把 `pedestrianSafety/data/*.json` 跟 `pedestrianSafety/data/build_*.py` 覆蓋回去就好。

## 交通方式:步行 / 機車 / 開車 / 大眾運輸

路線分頁最上面可以切換交通方式。設定都集中在 `modes.js`:

| | 路線 | 評分 | 資料範圍 | 門檻(分數 0 / 100 的密度,在參考半徑) |
|---|---|---|---|---|
| 🚶 步行 | 步行路網(routing.openstreetmap.de/routed-foot) | 行人事故 40% + 路燈 30% + 便利商店 30% | 自動(最近的道路,最遠 150 m) | 150 m:事故 38 件/km²/年(距離加權);路燈 1,800 盞/km² |
| 🛵 機車 | 汽車路網,**排除國道/快速道路**(`exclude=motorway`) | 有機車涉入的事故 70% + 路燈 30% | 自動(最近的車道,最遠 80 m) | 50 m:事故 ≈1,140;路燈 ≈2,550 |
| 🚗 開車 | 汽車路網(routed-car) | 有汽車涉入的事故 70% + 路燈 30% | 自動(最近的車道,最遠 80 m) | 50 m:事故 ≈420;路燈 ≈2,550 |
| 🚇 大眾運輸 | TDX 路徑規劃 API(公車、捷運、台鐵、高鐵、輕軌、渡輪、纜車) | **只評步行段**(走去搭車、轉乘、下車走到目的地),用步行的評分 | 同步行 | 同步行 |

### 資料範圍自動判定(2026/10 起,取代使用者輸入的緩衝半徑)

固定半徑兩頭都不對:太大,校內小路會算到圍牆外大馬路的事故;太小,座標有 10–30 m 誤差、其實發生在路上的事故會漏掉。現在改成**每筆資料歸給離它最近的那條路**(`roadNetwork.js` + `pedestrianSafety/roadAttribution.js`):

- 道路形狀來自 OpenStreetMap(Overpass API),以 0.01° 格子抓,存在記憶體和 `pedestrianSafety/data/osmRoadCache/`(30 天),同一區域第二次就不用連網。可用 `.env` 的 `OVERPASS_URL` 換伺服器(逗號分隔可給多個)。
- 規則(步行;機車/開車只比可以開車的道路):離路線 15 m 內一定算(座標誤差);150 m 外一定不算;中間的,只要沒有其他道路比路線近 10 m 以上就算。離路線 25 m 內的道路(人行道、對向車道、路口)當成路線本身。
- 計分面積用同一個規則:150 m 內「離這條路線比離其他道路近」的地面。面積換算成**等效半徑**(同面積的直線緩衝帶半徑),門檻和距離加權都用這個半徑(`radiusThresholds.js`)。所以街道密的地方範圍自然窄,公園、校園裡範圍自然寬。
- 連不到 Overpass 時自動退回固定半徑(步行 150 m、機車/開車 50 m),畫面會寫「改用固定範圍」;失敗後 5 分鐘內不會再試,避免每次都等逾時。
- API 仍可加 `bufferRadius=` 強制用固定半徑(做實驗用);不給就是自動。
- **門檻隨半徑調整**:密度門檻是在某個半徑校正的,半徑越窄、範圍內馬路比例越高,密度本來就越高。`scripts/calibrate-radius.mjs` 在 20–300 m 八種半徑各取 12,000 個台北道路點,找出跟參考門檻同一個百分位的值(例:步行事故 30 m → 137、50 m → 88、150 m → 38)。

- **事故資料**:機車/開車用 `accidentsAllTaiwan.bin.gz`——2021–2025 全台**所有** A1/A2 事故(1,932,902 筆),每筆標記涉入的對象(行人/機車/汽車/自行車)。因為筆數太多,存成壓縮二進位檔(每筆 13 bytes,12 MB),由 `accidentIndex.js` 載入並建格網索引。重建:`python3 pedestrianSafety/data/build_accidents_all_modes.py --sql-dir csv --out pedestrianSafety/data/accidentsAllTaiwan.bin.gz`。「汽車」= 小客車、小貨車、大貨車、大客車、曳引車、聯結車、特種車、軍車。
- **門檻怎麼來的**:`npm run calibrate`(`scripts/calibrate-modes.mjs`)。在台北實際道路上取 3,000 個點(路燈位置),步行門檻 80 件在這些點裡是第 98.9 百分位,機車/汽車門檻就取各自事故密度的同一個百分位,路燈同理——意思是「分數 0」在每種交通方式代表一樣極端的路段。6,000 點重跑結果幾乎一樣(2,293 / 841)。
- **不同交通方式的分數不能直接互相比較**(只對齊了「0 分」那一端,中間的分布形狀不同);只比較同一種交通方式的路線。畫面的比較分析也會寫這句提醒。
- **機車排除國道**:路線伺服器不支援時會退回一般汽車路網,畫面會警告「可能經過機車不能走的路段」。
- **便利商店**不計入機車/開車(它代表「路上有人看著」,是步行安全的指標)。
- **大眾運輸**需要 `.env` 的 `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`(跟 112-project 同一組)。最多 3 個方案,依步行段分數排序(差 1 分以內選比較快的)。可設定出發時間。不支援中途點。TDX 沒提供線形的搭乘段,地圖用虛線直線示意。TDX 官方文件沒寫回應格式,`transitPlanner.js` 的解析寫得比較寬鬆;要看 TDX 實際回了什麼可以開 `/api/transit/raw?startLat=..&startLon=..&endLat=..&endLon=..`(輸出不含金鑰)。
- 單點查詢分頁可以查「機車事故」「汽車事故」。

## 全台資料(2026/10 起)

伺服器會優先載入全台資料檔,沒有的話自動退回原本的台北市檔案(`nationalData.js` 負責這件事,`pedestrianSafety/` 評分模組本身沒改):

| 資料 | 檔案 | 範圍 | 怎麼產生 |
|---|---|---|---|
| 行人事故 | `realAccidentsTaiwan.json` | 全台 22 縣市,2021–2025,85,758 筆 | `python3 pedestrianSafety/data/build_real_accidents.py --sql-dir csv --out pedestrianSafety/data/realAccidentsTaiwan.json --region taiwan` |
| 路燈 | `realStreetlightsTaiwan.json.gz` + `realStreetlightsCoverage.json` | **全市**:臺北市、新北市、基隆市、新竹市、臺中市;**部分地區**:桃園市(只有中壢區)、臺南市(15 區)、高雄市(35 區,缺茂林/桃源/那瑪夏)。共 1,040,610 盞 | 見下方指令 |
| 便利商店 | `realConvenienceStoresTaiwan.json` | 全台,7-11 / 全家 / 萊爾富 / OK(全聯預設不算) | **`npm start` 會自動下載**(第一次、之後每 30 天),來源 taiwan-cvs-map.netlify.app;手動:`npm run update-stores -- --force` |

- **路燈資料重建指令**(從專案根目錄;台北/新北用 112-project `sql/street_light.py` 產生的 `street_light_all.csv`):

  ```
  python3 pedestrianSafety/data/build_real_streetlights.py ^
    --csv csv/路燈資料/台北路燈/street_light_all.csv --csv csv/路燈資料/台中路燈 ^
    --csv csv/路燈資料/基隆路燈 --csv csv/路燈資料/新竹路燈 ^
    --csv csv/路燈資料/桃園路燈/桃園中壢區公所路燈資料 ^
    --csv csv/路燈資料/台南路燈 --csv csv/路燈資料/高雄路燈 ^
    --partial 臺南市 --partial 桃園市 --partial 高雄市 ^
    --out pedestrianSafety/data/realStreetlightsTaiwan.json.gz
  ```
  (Windows 命令提示字元用 `^` 換行;PowerShell 用 `` ` ``。)各縣市格式不同,程式會看標題列自動判斷:基隆、桃園中壢只有 TWD97 座標,會轉成經緯度(轉換公式用新竹市同時附兩種座標的檔驗證過,誤差 < 1 mm);臺南有些區同一份資料發布兩次(一份用區名、一份用區碼),重複的會自動去掉;高雄資料夾裡檔名有「 (1)」的是重複下載,會跳過;`桃園市公有路燈桿懸掛廣告物…彙整表` 不是路燈位置,不要加進來。座標明顯打錯(落在該縣市範圍外)的會丟掉。輸出用 gzip 壓縮(100 萬盞的純 JSON 有 23 MB)。舊的 `realStreetlightsTaiwan.json` 可以刪掉,伺服器會優先讀 `.json.gz`。
- **只有部分行政區的縣市**(`--partial`):這些縣市只在「有路燈資料的地方」算路燈分數。做法是把有路燈的 0.005°(約 550 m)格子記在 `realStreetlightsCoverage.json` 的 `partialCities`,路線每 50 m 取一點檢查是否落在這些格子裡。例如台南安平、中西區、桃園市區(非中壢)的路段會算「路燈無資料」,而不是「完全沒有路燈 = 0 分」。之後補到其他行政區的 CSV,丟進同一個資料夾重跑即可;整個縣市都齊了就把那個 `--partial` 拿掉。
- **沒有路燈資料的縣市**:路燈那一項顯示「無資料」、不計分,總分由事故 + 便利商店依原權重比例換算(40:30);路線只有一部分在有資料的縣市時,路燈密度只用那一段計算。畫面和比較分析都會寫出路線經過哪些縣市、哪一項沒資料。要加新的縣市路燈,把 CSV 放進 `csv/路燈資料/`,用 `--csv` 加進上面的指令重跑即可(格式不同的話在 `read_rows()` 加一個讀法)。
- **速度**:評分前只取路線附近的點(結果跟全掃一模一樣,已驗證),一條路線約 10–70 ms。
- **校正**:分數門檻(事故 80 件/km²/年、路燈 1,800 盞/km²、便利商店 90 家/km²)是用台北市路段校正的,其他縣市的分數**僅供相對比較**,寫論文時要註明。
- **事故 `--region taiwan` 的座標檢查**:每筆事故的座標要落在「發生地點」所寫縣市的範圍內(各縣市外框 + 0.05° 緩衝),排除掉的幾乎都是 (9.0, 110.0) 這種明顯錯誤的座標。`--region` 不給時行為跟以前完全一樣(已驗證重跑結果與原 `realAccidentsTaipei.json` 逐筆相同)。
- **便利商店下載**:會排除座標跟地址縣市不符的店(地理編碼錯誤)、重複列;下載失敗或資料量不到舊檔一半時保留舊檔,不會擋住伺服器啟動。下載時間和各品牌筆數記在 `realConvenienceStoresTaiwan.meta.json`。資料來自「台灣便利商店飽和度地圖」(楊軒銘),報告裡請註明來源。
- `npm run audit` 會檢查目前實際載入的檔案(全台的話用台灣範圍檢查座標,並列出座標縣市跟地點文字不一致的比例,約 1.2%,幾乎都是縣市交界的路)。

## 怎麼在 VS Code 跑起來

1. 用 VS Code 開啟這個資料夾(`File → Open Folder`)。
2. 開一個終端機(`Terminal → New Terminal`),執行:
   ```
   npm install
   npm start
   ```
3. 瀏覽器打開 http://localhost:3001

預設跑在 3001 埠,跟主專案的 3000 不衝突,兩個可以同時開著對照。想改埠號或指向自己架的 OSRM,可以照 `.env.example` 的樣子建一個 `.env`(這個專案沒有強制要求 `.env`,沒有也能跑,只是「點地圖算路線」那個功能需要連得到 OSRM)。

## 介面有三個分頁

- **路線安全評分**:起點/終點可以直接**打字**輸入地名、地址或 `lat,lon`(按 Enter 或 🔍 搜尋),也可以按輸入框旁的 🎤 **用說的**;最上面的大麥克風可以一句話說「從台北車站到台北101」,會自動填好兩邊並算分。搜尋會自動選第一個結果,下面列出其他候選,選錯可以點換。點地圖仍可當備用。算這段路的安全分數,下面會列出緩衝範圍內抓到的每一筆事故/路燈/商店原始資料。路線先用 `routing.openstreetmap.de` 的**真正步行路線**(免金鑰,可用 `.env` 的 `OSRM_FOOT_BASE_URL` 改),連不到才退回 `OSRM_BASE_URL`(預設 `router.project-osrm.org`——注意這台示範伺服器其實只有汽車路線,會走單行道、快速道路,`profileUsed` 會標示出來)。地圖上畫的是實際路線、淺藍色的緩衝範圍帶,以及緩衝範圍內**全部**的事故/商店/路燈點(跟分數用的筆數一致),左下角可以分別開關;如果你的環境連不到它,會顯示錯誤,但下面「單點查詢」跟「資料總覽」兩個分頁完全不需要 OSRM,隨時都能用。
  - 地名→座標由伺服器的 `/api/geocode?q=...` 代查:先用跟主專案**同一支** `placeSearchEngine.js`(從 112-project/backend 複製,有「101→台北101、北車→台北車站」這類別名表;`.env` 有填 `TOMTOM_API_KEY` / `GROQ_API_KEY` 就會用,沒填就走 Photon),找不到時再用 OpenStreetMap 的 **Nominatim** + Photon 備援,免 API key。會自動試「台/臺」兩種寫法,門牌找不到時退回到路段(畫面會標示「近似」)。Nominatim 規定每秒最多 1 次查詢,伺服器已經自動限速+快取。可在 `.env` 用 `NOMINATIM_BASE_URL`、`PHOTON_BASE_URL`、`GEOCODER_USER_AGENT` 覆蓋。
  - 語音輸入用瀏覽器內建的 Web Speech API(中文 zh-TW),**請用 Chrome 或 Edge**(Firefox 不支援),而且要用 `http://localhost:3001` 開(用區網 IP 開會被瀏覽器擋麥克風),第一次會跳出麥克風權限,按允許。Chrome 的語音辨識需要網路。
- **📍 目前位置當起點**:按起點旁的 📍(或語音說「從這裡到…」),用瀏覽器定位;會顯示精確度,超過 500 公尺會提醒(桌機/筆電沒有 GPS,通常只能用 Wi-Fi 估計)。第一次會詢問位置權限;Windows 要在「設定 → 隱私權 → 位置」開啟定位服務。地址由 `/api/reverse`(Nominatim)查出,查不到就只顯示座標。
- **中途點(轉接點)**:按「＋ 新增中途點」,最多 5 個,每個都可以打字/語音/搜尋,可個別移除;路線會依序經過。語音可以說「從台北車站經過西門町和龍山寺到台北101」。比較功能產生的每一條路線都會經過全部中途點:繞行候選點插在「多走最少」的那一段,不會打亂順序。API 參數 `via=lat,lon;lat,lon`。
- **多路線比較(推薦 / 備選1 / 備選2)**:按「規劃路線並比較安全性」後,會用跟 112-project 主系統步行模式**一樣的設定**產生最多 3 條不同的步行路線,每條都用原本的安全評分公式(事故 40% + 路燈 30% + 便利商店 30%)打分,分數最高的是推薦路線(差 1 分以內視為平手,選較短的)。畫面會顯示比較分析文字、每條路線的分數卡、並排比較表(每項最好的用綠色粗體),以及推薦路線上事故最集中的路段(⚠)。點卡片或地圖上的虛線可以切換要看哪條路線的詳細資料。
  - 路線候選:先用 OSRM `alternatives=true`;不足 3 條時用 `routeAlternatives.js`(從主專案原封不動複製)補繞行路線——先避開事故聚集段(150m 緩衝、推 300m),沒有聚集再用兩側幾何偏移。繞超過最短路線 1.8 倍的不採用;沒有真正步行路網時,時間用 4.8 km/h 換算。
  - 跟主系統的差別:主系統只在「OSRM 只給 1 條」時補繞行、並只用距離差 3% 判斷重複;這裡只要不足 3 條就補,重複判斷改用路線形狀重疊度(85% 以上重疊才算同一條)。規則都寫在 `routeComparison.js` 開頭。
  - API:`GET /api/pedestrian-safety/compare?startLat=&startLon=&endLat=&endLon=&dataSource=real`(不給 `bufferRadius` = 資料範圍自動判定;原本單一路線的 `/api/pedestrian-safety` 保留不變)。
- **單點查詢(資料核對)**:輸入/說出一個地點(或在地圖上點任意一點),直接列出附近真正記錄到的原始資料(日期、地點文字、經緯度、距離),方便你拿去跟 Google 街景或政府開放資料原始網站一筆一筆核對是不是真的有這件事/這盞燈/這家店。這是專門為了你要做的「資料正確性」改進設計的功能。
- **資料總覽 / 稽核**:即時讀取目前 `pedestrianSafety/data/*.json` 的實際內容(筆數、日期範圍、座標範圍、分年/分品牌統計),不是寫死的數字。改完資料、重跑下面的 build 腳本之後,按這個馬上就能確認有沒有生效。

## 系統化資料檢查:`npm run audit`

終端機執行 `npm run audit`(或 `node audit.js`),會自動檢查三個資料集的常見問題類型,並且把完整結果寫到 `audit-report.json`:

- **座標是否真的落在台北市範圍內**(之前在主專案抓到過一筆事故座標是 (25.333, 121.333),看起來像台灣座標,但其實不在事故地點文字寫的行政區裡,這種錯誤這個檢查抓得到)
- **完全重複的紀錄**(同一天同一時間同一座標的事故、同座標同品牌的商店——通常代表 build 資料時不小心把同一個來源檔案合併了兩次)
- **缺漏欄位**(座標不是數字、事故日期解析失敗)
- **逐年事故筆數異常**(某一年筆數跟其他年差超過 35%,可能代表那一年的檔案只讀到一部分)

這個指令不需要先啟動 `npm start`,是獨立的腳本,跑完也不會動到任何資料檔,純粹只是檢查、印報告。

## 三個資料來源,各自的「正確性」現況與改進方向

這是你這次要改進的重點,整理現況給你參考:

### 1. 交通事故(`pedestrianSafety/data/realAccidentsTaipei.json`)

目前來源是內政部警政署官方 A1(死亡/24小時內)+ A2(受傷)交通事故資料,110-114年度(2021-2025,近5年,近期才應你要求把 107-109年度拿掉),只保留「發生地點是台北市」且「至少一方是行人」的紀錄,共 9,296 筆。這是三個資料集裡**可信度最高**的一個,因為是政府官方逐案記錄,不是推算或爬蟲來的。

改進方向:
- 重新產生資料用 `pedestrianSafety/data/build_real_accidents.py`,指令是 `python3 build_real_accidents.py --sql-dir <放CSV的資料夾> --out pedestrianSafety/data/realAccidentsTaipei.json`。原始 CSV 要從 https://data.gov.tw (搜尋「道路交通事故資料」)或警政署開放資料平台抓。
- 如果要更新到更近的年度(115年度/2026年),等政府正式公布 A1/A2 格式的 CSV 後,把對應檔名加進 `build_real_accidents.py` 的 `NEW_FORMAT_YEARS` 清單即可,不用改其他程式碼。
- 跑完 `npm run audit` 確認沒有座標跑出台北市範圍、沒有重複紀錄。

### 2. 路燈(`pedestrianSafety/data/realStreetlightsTaipei.json`)

目前是台北市路燈登記資料(`TaipeiLight.csv`)的靜態快照,145,813 筆,**是這三個資料集裡最久沒更新、也最沒有"真實數量"驗證過的一個**——它是路燈的「登記筆數」,不代表「目前還站在那裡、還會亮」的真實數量(有些可能已拆除,也可能有新增的沒登記進去)。這一塊最值得你花時間改進。

改進方向:
- 去台北市資料大平台(data.taipei)或台北市工務局公燈處找最新版的路燈 GIS/開放資料,確認筆數、更新日期,跟現在這份比對差異。
- `npm run audit` 抓到 36 筆完全重複座標——這不一定是錯(兩盞燈裝在同一根電桿本來就可能座標一樣),但值得你挑幾筆出來,用「單點查詢」分頁輸入那個座標,對照 Google 街景看看那個路口實際上有幾盞燈。
- 如果找到更新的資料來源,可以仿照 `build_real_stores.py` 的寫法,寫一個對應的轉換腳本,直接輸出成 `{latitude, longitude}` 陣列存成 `realStreetlightsTaipei.json`。

### 3. 便利商店(`pedestrianSafety/data/realConvenienceStoresTaipei.json`)

目前 1,940 筆,組成不一致:
- **7-Eleven(975 筆)、全家(645 筆)是即時的**——直接打這兩個品牌自己的官方門市查詢 API 抓的(用的是 `taiwan-cvs-map` 這個專案的程式,`pedestrianSafety/data/taiwan-cvs-map-source/` 裡有抓到的原始資料跟抓取時間),2026/09/01 的快照,是四個品牌裡最可信的。
- **萊爾富、OK超商(211 + 109 筆)是舊的、大約 2015 年的資料**,來源是一個很久以前的社群整理專案,**這是便利商店資料裡最明確的正確性問題**——人數比例上這兩個品牌實際上應該更多,而且 10 年前的門市現在很多已經關了或搬了。

改進方向:
- 優先處理萊爾富/OK超商:去找這兩個品牌有沒有公開的門市查詢 API(可以參考 `taiwan-cvs-map` 這個 GitHub 專案的做法,看它有沒有後續擴充支援這兩個品牌;或是直接研究這兩家官網的「門市查詢」頁面背後打的 API)。
- 專案自己的 `sql/全國5大超商資料集.csv`(政府公司登記資料)其實涵蓋全部五大超商,但只有文字地址沒有經緯度,之前評估過要整批做地理編碼(把地址轉成經緯度)工程量太大而擱置——如果你想做,ORS(openrouteservice)或 GraphHopper 除了算路線也都有地理編碼 API,免費額度應該夠用。
- 新資料準備好後,用 `build_real_stores.py` 合併進來(看檔案開頭的 usage 說明)。
- `npm run audit` 抓到 19 筆完全重複座標+品牌組合,其中有幾筆是「同一個經緯度、好幾個不同店名」(例如台鐵站裡三家都叫「全家台鐵OO店」座標完全一樣)——這種要特別確認是不是同一棟建築裡真的有多個不同櫃位,還是 API 本身對同一間店回傳了重複資料。

## 檔案結構

```
pedestrian-safety-lab/
  server.js              -- Express 伺服器,從 112-project 的 /api/pedestrian-safety 搬過來,
                             另外加了 /api/data-summary 跟 /api/nearby 兩個新端點
  audit.js                -- 資料正確性檢查腳本(npm run audit)
  placeSearchEngine.js    -- 地名→座標(從 112-project/backend 原封不動複製)
  routeAlternatives.js    -- 繞行候選路線(從 112-project/backend 原封不動複製)
  routeComparison.js      -- 多路線產生、評分、排名、比較分析
  nationalData.js         -- 載入全台資料(沒有就用台北)、縣市涵蓋判斷、路線附近點預先篩選
  modes.js                -- 交通方式設定(權重、緩衝、門檻)與機車/開車評分
  roadNetwork.js          -- 從 Overpass 抓 OSM 道路(格子快取),給資料範圍自動判定用
  accidentIndex.js        -- 載入全部事故(二進位)+ 格網索引
  transitPlanner.js       -- 大眾運輸(TDX 路徑規劃)與步行段評分
  scripts/calibrate-modes.mjs -- 機車/開車門檻校正
  scripts/calibrate-radius.mjs -- 各半徑的門檻校正(radiusThresholds.js 的數字來源)
  scripts/update-stores.mjs -- 下載並轉換全台便利商店資料(npm start 前自動執行)
  csv/                    -- 原始 CSV(事故 110–114 年、各縣市路燈),不會被伺服器直接讀取
  pedestrianSafety/        -- 112-project 的安全評分模組,原封不動複製
    scoring.js              -- 評分公式本體
    routeAnalysis.js        -- 路線緩衝區比對邏輯、事故距離加權
    roadAttribution.js      -- 每筆資料歸給最近的道路(資料範圍自動判定)
    radiusThresholds.js     -- 門檻隨(等效)半徑調整
    geoUtils.js              -- 座標轉換小工具
    index.js                 -- 模組對外的匯出入口
    data/
      realAccidentsTaipei.json / realTaipeiData.js   -- 事故+路燈+商店資料與來源說明
      realStreetlightsTaipei.json
      realConvenienceStoresTaipei.json
      build_real_accidents.py                         -- 重新產生事故資料用
      build_real_stores.py                             -- 重新產生商店資料用
      taiwan-cvs-map-source/                           -- 7-Eleven/全家原始抓取資料
  public/                  -- 瀏覽器前端(地圖 + 三個分頁),純 HTML/CSS/JS,沒有打包流程
```
