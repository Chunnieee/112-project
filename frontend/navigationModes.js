const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const number = (n, digits = 1) => typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '無資料';
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key,value) => { try { localStorage.setItem(key,value); } catch {} };

import { createNightMap } from './nightMap.js';
import { createSimulationDialog } from './navigationSimulation.js';

export function createNavigationModes({ baseUrl, getRoutes, getMode, getTripLabel, selectRoute, getSelectedIndex, rerender, map, mapReady, Popup }) {
  const $ = id => document.getElementById(id);
  let participantId = read('risknav-participant');
  if (!participantId || !/^[a-zA-Z0-9-]{16,80}$/.test(participantId)) {
    participantId = crypto.randomUUID(); write('risknav-participant',participantId);
  }
  let night = read('risknav-night') === 'true';
  let distribution = read('risknav-distribution') === 'true';
  let result = null, busy = false, choosing = false, failure = '', notice = '', generation = 0, timer = null, controller = null;
  $('nightModeToggle').checked = night;
  $('distributionToggle').checked = distribution;
  const nightMap = createNightMap({ map,mapReady,Popup,request });
  const simulation = createSimulationDialog({ request,getPlan:()=>result,selectRoute,
    prepare:async () => {
      if (!getRoutes().length) return;
      if (!distribution) {
        distribution=true; $('distributionToggle').checked=true; write('risknav-distribution','true'); updateMenu();
        await analyze({autoSelect:false});
      } else if (!result) await analyze({autoSelect:false});
    } });
  $('routeSimulationButton').addEventListener('click',()=>{closeMenu();simulation.open();});

  async function request(path, body, signal) {
    const response = await fetch(`${baseUrl}/api/navigation/${path}`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, participantId }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '服務暫時無法使用。'), { status: response.status });
    return data;
  }
  function updateMenu() {
    const active = Number(night)+Number(distribution);
    $('navigationModeCount').hidden = !active;
    $('navigationModeCount').textContent = active;
    document.body.classList.toggle('night-safety-active',night);
  }
  function closeMenu(returnFocus = false) {
    $('navigationMenuPanel').hidden = true;
    $('navigationMenuButton').setAttribute('aria-expanded','false');
    if (returnFocus) $('navigationMenuButton').focus();
  }
  $('navigationMenuButton').addEventListener('click', () => {
    const open = $('navigationMenuPanel').hidden;
    $('navigationMenuPanel').hidden = !open;
    $('navigationMenuButton').setAttribute('aria-expanded',String(open));
  });
  document.addEventListener('click', e => { if (!e.target.closest('.navigation-menu')) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('navigationMenuPanel').hidden) closeMenu(true); });
  $('nightModeToggle').addEventListener('change', () => { night = $('nightModeToggle').checked; write('risknav-night',String(night)); updateMenu(); analyze(); });
  $('distributionToggle').addEventListener('change', () => { distribution = $('distributionToggle').checked; write('risknav-distribution',String(distribution)); updateMenu(); analyze(); });

  function reset() {
    generation++; controller?.abort(); clearTimeout(timer);
    result = null; busy = false; choosing = false; failure = ''; notice = ''; simulation.invalidate(); render();
  }
  async function analyze({ autoSelect = true } = {}) {
    reset();
    const routes = getRoutes();
    if ((!night && !distribution) || !routes.length) { rerender(); return; }
    const epoch = generation;
    controller = new AbortController(); busy = true; render(); rerender();
    try {
      const data = await request('analyze', { night, distribution, mode: getMode(),
        tripLabel: getTripLabel(),
        routes: routes.map(r => ({ geometry: r.geometry, expectedMin: r.expectedMin })) }, controller.signal);
      if (epoch !== generation || routes !== getRoutes()) return;
      result = data;
      if (autoSelect) {
        const chosen = data.routes.find(r => r.selected)?.index ?? data.recommendedIndex;
        if (chosen !== null && chosen !== undefined) selectRoute(chosen, { fit: false });
      }
    } catch(e) { if (epoch === generation && e.name !== 'AbortError') failure = e.message; }
    finally { if (epoch === generation) { busy = false; rerender(); render(); schedule(); } }
  }
  function schedule() {
    clearTimeout(timer);
    if (distribution && result) timer = setTimeout(refresh, 15000);
  }
  async function refresh() {
    if (!result || choosing || document.hidden) { schedule(); return; }
    const epoch = generation, id = result.planId;
    try {
      const data = await request('status',{ planId: id });
      if (epoch !== generation || choosing) return;
      result = data; failure = ''; rerender(); render();
    } catch(e) {
      if (epoch !== generation) return;
      if (e.status === 410) { analyze({ autoSelect: false }); return; }
      failure = '人數更新失敗，目前顯示上次紀錄。可按重新分析再試。'; render();
    }
    schedule();
  }
  async function choose(index) {
    const row = result?.routes[index];
    if (!distribution || !row || choosing || busy) return;
    const epoch = ++generation;
    choosing = true; failure = ''; notice = ''; rerender(); render();
    try {
      const data = await request('choice', { planId: result.planId, routeKey: row.key });
      if (epoch !== generation) return;
      result = data;
      const after = data.routes.find(r => r.key === row.key), before = data.before.find(r => r.key === row.key);
      const delta = after.model && before.model ? after.model.total-before.model.total : null;
      notice = data.change.changed
        ? `已記錄${row.label}。${data.change.previousRoute ? '原路線 −1、這條路線 +1。' : '這條路線 +1。'}${delta === null ? '' : `推薦成本 +${number(delta,6)}；預估時間及安全分數不變。`}`
        : '這條路線已記錄，重複確認不增加人數。';
      selectRoute(index, { fit: false });
    } catch(e) {
      if (epoch === generation) failure = `${e.message} 選擇尚未記錄，請重試。`;
    } finally { if (epoch === generation) { choosing = false; rerender(); render(); schedule(); } }
  }
  function card(index) {
    if (!night && !distribution) return '';
    const row = result?.routes[index];
    return `<div class="route-mode-summary">
      ${night ? `<span class="safety-chip">☾ 安全 ${row?.safety?.status === 'ok' ? `${number(row.safety.score)} / 100` : busy ? '分析中…' : '無資料'}</span>` : ''}
      ${distribution ? `<span class="distribution-chip">${row ? `近 10 分鐘 ${row.count} 人選擇` : '選擇人數待更新'}</span>` : ''}
      ${row?.recommended ? '<span class="mode-recommended">模式推薦</span>' : ''}
      ${distribution ? `<button class="choose-route-button ${row?.selected ? 'confirmed' : ''}" type="button" data-choice-index="${index}" ${!row || busy || choosing || row.selected ? 'disabled' : ''}>${row?.selected ? '✓ 已選擇這條路線' : choosing ? '記錄中…' : '選擇這條路線'}</button>` : ''}
    </div>`;
  }
  function render() {
    nightMap.update({night,planId:result?.planId,row:result?.routes[getSelectedIndex()]});
    const panel = $('navigationInsights');
    const modelOpen = panel.querySelector('.model-explanation')?.open;
    panel.hidden = !night && !distribution;
    if (panel.hidden) { panel.innerHTML = ''; return; }
    const routes = getRoutes(), row = result?.routes[getSelectedIndex()];
    const headings = `${night ? '☾ 夜間安全' : ''}${night && distribution ? ' ＋ ' : ''}${distribution ? '⑂ 路線分流' : ''}`;
    let html = `<div class="insight-heading"><strong>${headings}</strong><span>已啟用</span></div>`;
    if (!routes.length) html += '<p>規劃路線後，這裡會顯示評分與推薦原因。</p>';
    else if (busy) html += '<p role="status">正在比對路線資料，第一次安全分析可能需要稍候…</p>';
    else if (row) {
      const recommendation = result.routes.find(r => r.recommended);
      html += `<p class="mode-recommendation">${recommendation ? `推薦${escapeHtml(recommendation.label)}` : '目前沒有足夠資料提供模式推薦'}${recommendation && !row.recommended ? ` · 正在查看${escapeHtml(row.label)}` : ''}</p>`;
      if (recommendation) html += `<ul class="recommendation-reasons">${recommendation.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
      if (night) {
        const safety = row.safety;
        html += `<div class="safety-total"><span>${escapeHtml(row.label)}的夜間安全</span><strong>${number(safety?.score)}${safety?.status === 'ok' ? '<small> / 100</small>' : ''}</strong></div>`;
        if (safety?.status === 'ok') {
          const labels = { accident: '事故', streetlight: '照明', store: '沿途商店' };
          html += `<div class="safety-factors">${Object.entries(labels).filter(([key]) => key !== 'store' || getMode() === 'walk').map(([key,label]) => `<div><span>${label}</span><strong>${number(safety.factors[key])}</strong></div>`).join('')}</div>`;
          html += `<p class="insight-note">${getMode() === 'walk' ? '事故 40%・照明 30%・商店 30%' : '事故 70%・照明 30%'}。各項均為越高越好。</p>`;
          if (safety.coverage?.adjusted) html += `<p class="coverage-note">${escapeHtml(safety.coverage.note)}</p>`;
          if (safety.attribution?.method === 'fixed-buffer') html += '<p class="insight-note">道路歸屬資料未齊，已改用固定範圍分析。</p>';
          if (safety.dateRange) html += `<p class="insight-note">事故資料：${escapeHtml(safety.dateRange.from)} ～ ${escapeHtml(safety.dateRange.to)}</p>`;
        } else html += `<p class="coverage-note">${escapeHtml(safety?.message || '這段路線缺少可用安全資料，未以零分或滿分替代。')}</p>`;
        html += '<p class="insight-note">估計分數供同交通方式比較；路燈登記不等於目前亮燈，商店不代表即時人流，也不保證實際安全。</p>';
      }
      if (distribution) {
        html += `<p class="insight-note">${escapeHtml(result.explanation)}</p><details class="model-explanation"><summary>查看分流評分方式</summary><p>推薦成本 = 預估分鐘 + 安全風險成本 + 分流成本，越低越優先。每條路線採相同分配參考值 20 人，不是道路容量。</p><p>分流成本 = 10 ×（近 10 分鐘選擇人數 ÷ 20）⁴。${night ? '安全風險成本 = 16 ×（100 − 安全分數）÷ 100。先限於最佳安全分數 5 分內，再限制額外時間。' : '目前未啟用安全風險加權，不表示風險為零。'} 最多接受比最快多 5 分鐘。</p>
          ${row.model ? `<p>${escapeHtml(row.label)}：安全風險成本 ${number(row.model.riskCost,3)} ＋ 分流成本 ${number(row.model.loadCost,6)}；總成本 ${number(row.model.total,6)}。</p><p>目前推薦權重 ${number(row.model.probability*100)}%，用來分散下一位的建議，不是事故機率。</p>` : ''}
          <p>${escapeHtml(result.overlapNote)}</p></details>`;
        html += `<p class="insight-note">以匿名裝置區分使用者，僅在確認選路後計數；10 分鐘到期後釋放，改選會轉移原紀錄。最後更新 ${new Date(result.updatedAt).toLocaleTimeString('zh-TW')}。</p>`;
        if (result.choiceExpiresAt) html += `<p class="insight-note">你的有效選擇將於 ${new Date(result.choiceExpiresAt).toLocaleTimeString('zh-TW')} 釋放。</p>`;
      }
    }
    if (notice) html += `<p class="choice-notice" role="status">${escapeHtml(notice)}</p>`;
    if (failure) html += `<p class="coverage-note" role="alert">${escapeHtml(failure)}</p>`;
    if (routes.length && !busy) html += '<button type="button" class="text-button" data-refresh-analysis>重新分析</button>';
    panel.innerHTML = html;
    if (modelOpen && panel.querySelector('.model-explanation')) panel.querySelector('.model-explanation').open = true;
    panel.querySelector('[data-refresh-analysis]')?.addEventListener('click', () => analyze({ autoSelect: false }));
  }
  $('routeList').addEventListener('click', e => {
    const button = e.target.closest('[data-choice-index]');
    if (button) { e.stopPropagation(); choose(Number(button.dataset.choiceIndex)); }
  });
  $('choiceHistoryButton').addEventListener('click', async () => {
    closeMenu(); $('choiceHistoryDialog').showModal(); $('choiceHistoryContent').textContent = '讀取紀錄中…';
    try {
      const data = await request('history',{});
      $('choiceHistoryContent').innerHTML = data.events.length ? data.events.map(e => `<article class="choice-event"><strong>${escapeHtml(e.decision.label)}${e.previous_route ? ' · 改選' : ' · 選擇'} · ${{walk:'步行',car:'汽車',scooter:'機車'}[e.mode] || ''}</strong><time>${new Date(e.chosen_at).toLocaleString('zh-TW')}</time><p>${escapeHtml(e.decision.tripLabel || '')}</p><p>預估 ${number(e.decision.expectedMin)} 分鐘${e.decision.night ? ` · 安全 ${number(e.decision.safetyScore)} 分` : ''} · ${e.decision.recommended ? '採用推薦' : '自行選擇'}</p><p>${e.decision.reasons.map(escapeHtml).join('；')}</p></article>`).join('') : '<p>尚未有選路紀錄。開啟分流並選擇一條路線後，就會顯示在這裡。</p>';
    } catch(e) { $('choiceHistoryContent').textContent = e.message; }
  });
  $('choiceHistoryClose').addEventListener('click', () => $('choiceHistoryDialog').close());
  updateMenu(); render();
  return { analyze, reset, render, card, active: () => night || distribution };
}
