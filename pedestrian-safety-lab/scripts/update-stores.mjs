// scripts/update-stores.mjs
//
// 下載全台便利商店資料(taiwan-cvs-map.netlify.app 的 data/stores.json,
// 作者楊軒銘,資料來自各品牌官網門市查詢,每月 1 號更新),轉成本專案的格式:
//   pedestrianSafety/data/realConvenienceStoresTaiwan.json
//   [{ latitude, longitude, store_type, name, address, city, district }, ...]
//
// `npm start` 之前會自動跑(package.json 的 prestart):
//   - 檔案不存在,或超過 30 天沒更新 → 下載並轉換
//   - 否則直接跳過(不連網)
//   - 下載失敗 → 印警告、保留舊檔、不擋伺服器啟動
// 手動強制更新:npm run update-stores -- --force
//
// 來源格式(每家店一個陣列):
//   [緯度, 經度, 品牌代碼, 店名, 縣市, 鄉鎮區, 村里, 地址]
//   品牌代碼:0=7-ELEVEN 1=全家 2=萊爾富 3=OK 4=全聯
// 縣市/鄉鎮區/村里是網站用座標套行政區界算出來的,所以拿來跟「地址」裡的
// 縣市比對,可以抓出座標放錯縣市的店(地理編碼錯誤)。
//
// 全聯是超市(晚上會關門),跟「24 小時有人」的便利商店意義不同,預設不納入;
// 要納入請設環境變數 INCLUDE_PXMART=1。

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "pedestrianSafety", "data");
const OUT = path.join(DATA_DIR, "realConvenienceStoresTaiwan.json");
const META = path.join(DATA_DIR, "realConvenienceStoresTaiwan.meta.json");

const SOURCE_URL = process.env.CVS_MAP_STORES_URL || "https://taiwan-cvs-map.netlify.app/data/stores.json";
const MAX_AGE_DAYS = 30;
const BRANDS = { 0: "7-Eleven", 1: "FamilyMart", 2: "Hi-Life", 3: "OK Mart", 4: "PX Mart" };
const COUNTIES = new Set([
  "臺北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣",
  "雲林縣", "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣",
  "金門縣", "連江縣",
]);

const force = process.argv.includes("--force");
const includePx = process.env.INCLUDE_PXMART === "1";

function log(msg) {
  console.log(`[update-stores] ${msg}`);
}

// "(10466)臺北市中山區..." / "100台北市..." -> "臺北市"; null if no known county prefix
function addressCounty(address) {
  const a = String(address || "")
    .replace(/^[(（]?\d{3,6}[)）]?/, "")
    .replace(/台/g, "臺")
    .trim();
  const head = a.slice(0, 3);
  return COUNTIES.has(head) ? head : null;
}

export function convert(raw, { includePxMart = false } = {}) {
  if (!Array.isArray(raw)) throw new Error("stores.json 不是陣列,格式可能改了");
  const out = [];
  const dropped = { badRow: 0, outsideTaiwan: 0, countyMismatch: 0, pxMart: 0, duplicate: 0 };
  const seen = new Set();
  for (const s of raw) {
    if (!Array.isArray(s) || s.length < 8) { dropped.badRow++; continue; }
    const [lat, lon, brandCode, name, city, district, , address] = s;
    const store_type = BRANDS[brandCode];
    if (!store_type || typeof lat !== "number" || typeof lon !== "number") { dropped.badRow++; continue; }
    if (brandCode === 4 && !includePxMart) { dropped.pxMart++; continue; }
    if (!(lat > 21.8 && lat < 26.5 && lon > 118 && lon < 122.1)) { dropped.outsideTaiwan++; continue; }
    const addrCounty = addressCounty(address);
    if (addrCounty && city && addrCounty !== String(city).replace(/台/g, "臺")) { dropped.countyMismatch++; continue; }
    // Same brand + same point + same name listed twice = duplicate row. Different
    // names at one point (e.g. 全家高鐵一店/二店 in one station) are kept.
    const key = `${brandCode}|${lat}|${lon}|${name}`;
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key);
    out.push({ latitude: lat, longitude: lon, store_type, name, address, city, district });
  }
  return { stores: out, dropped };
}

async function main() {
  if (!force && existsSync(OUT)) {
    const ageDays = (Date.now() - statSync(OUT).mtimeMs) / 86400000;
    if (ageDays < MAX_AGE_DAYS) {
      log(`全台便利商店資料 ${ageDays.toFixed(0)} 天前更新過,跳過(--force 可強制更新)`);
      return;
    }
  }

  log(`下載 ${SOURCE_URL} ...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let raw;
  try {
    const res = await fetch(SOURCE_URL, { signal: controller.signal, headers: { "User-Agent": "pedestrian-safety-lab" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const { stores, dropped } = convert(raw, { includePxMart: includePx });

  // Guard against a truncated/partial download wiping out good data.
  if (existsSync(OUT)) {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    if (stores.length < prev.length * 0.5) {
      throw new Error(`新資料只有 ${stores.length} 筆,不到舊資料 ${prev.length} 筆的一半,疑似下載不完整,保留舊檔`);
    }
  } else if (stores.length < 5000) {
    throw new Error(`只轉出 ${stores.length} 筆,資料量不合理,不寫入`);
  }

  const byBrand = {};
  for (const s of stores) byBrand[s.store_type] = (byBrand[s.store_type] || 0) + 1;
  writeFileSync(OUT, JSON.stringify(stores));
  writeFileSync(
    META,
    JSON.stringify(
      {
        source: SOURCE_URL,
        sourceCredit: "台灣便利商店飽和度地圖(楊軒銘),資料來自各品牌官網,每月 1 號更新",
        fetchedAt: new Date().toISOString(),
        includePxMart: includePx,
        total: stores.length,
        byBrand,
        dropped,
      },
      null,
      2
    )
  );
  log(`完成:${stores.length} 家 ${JSON.stringify(byBrand)}`);
  log(`排除:${JSON.stringify(dropped)}`);
}

// Only run when executed directly (the converter is also imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log(`⚠ 更新失敗:${err.message}`);
    log(existsSync(OUT) ? "繼續使用現有的全台便利商店資料。" : "目前沒有全台便利商店資料,伺服器會改用台北市資料。");
    process.exitCode = 0; // never block `npm start`
  });
}
