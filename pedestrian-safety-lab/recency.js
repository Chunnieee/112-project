// recency.js
//
// 事故的「時間衰減」權重：越久以前的事故，在事故分數裡占的比例越少。
//
//   權重 = 0.5 ^ (事故距資料最後一天的年數 / 半衰期)
//   半衰期預設 2 年（.env 的 ACCIDENT_HALF_LIFE_YEARS 可調；設 0 或 off = 關閉，回到每年同權重）
//     → 最近一年 ≈ 0.7～1、2 年前 0.5、4 年前 0.25
//
// 分數公式原本是「事故數 ÷ 面積 ÷ 資料年數」= 每年每 km² 事故數，門檻也是用這個單位校正的。
// 加上衰減後，分母改成「有效年數」（同樣衰減權重下，資料期間的總權重），
// 所以「每年事故數都一樣」的路段分數完全不變；只有近年變多或變少的路段會被往上或往下修正，
// 門檻不用重新校正。

const raw = String(process.env.ACCIDENT_HALF_LIFE_YEARS ?? "2").trim().toLowerCase();
const parsed = Number(raw);
export const HALF_LIFE_YEARS = raw === "off" || !Number.isFinite(parsed) || parsed <= 0 ? null : parsed;
export const recencyEnabled = HALF_LIFE_YEARS != null;

const YEAR_MS = 365.25 * 86400000;

/** 單筆事故的時間權重（0～1）。沒有日期或關閉衰減時回傳 1。 */
export function recencyWeight(date, endMs) {
  if (!recencyEnabled || !Number.isFinite(endMs)) return 1;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return 1;
  const ageYears = Math.max(0, (endMs - t) / YEAR_MS);
  return Math.pow(0.5, ageYears / HALF_LIFE_YEARS);
}

/** 資料期間 spanYears 年、在衰減權重下等於幾個「完整年」：∫0^span 0.5^(t/h) dt */
export function effectiveYears(spanYears) {
  if (!(spanYears > 0)) return 1;
  if (!recencyEnabled) return spanYears;
  const h = HALF_LIFE_YEARS;
  return (h / Math.LN2) * (1 - Math.pow(0.5, spanYears / h));
}

/** 資料期間 { from, to }（YYYY-MM-DD）→ { endMs, spanYears, effYears } */
export function recencyWindow(range) {
  const from = Date.parse(range?.from), to = Date.parse(range?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const endMs = to + 86400000; // 含最後一天
  const spanYears = (endMs - from) / YEAR_MS;
  return { endMs, spanYears, effYears: effectiveYears(spanYears) };
}
