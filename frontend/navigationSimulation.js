const esc = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (value,d=1) => Number.isFinite(value) ? value.toFixed(d) : '—';
const COLORS = ['#79a7ff','#66dbb6','#efbe69','#cb9afa','#f294b4'];

export function createSimulationDialog({ request,getPlan,selectRoute,prepare }) {
  const $=id => document.getElementById(id), dialog=$('routeSimulationDialog');
  let data=null, busy=false, error='', planId=null, epoch=0;
  function invalidate() {
    epoch++; data=null; planId=null; busy=false; error='';
    if (dialog.open) render();
  }
  function render() {
    const plan=getPlan();
    $('simulationContext').textContent = plan ? `目前候選路線 · ${plan.routes.length} 條${plan.config.riskWeight ? ' · 已納入夜間安全條件' : ' · 未加權夜間安全'}` : '請先在主畫面規劃路線，再開啟分流模擬。';
    $('simulationStatus').textContent=error || (busy ? '正在更新模擬…' : '');
    $('simulationStatus').setAttribute('role',error ? 'alert' : 'status');
    $('simulationControls').hidden=!data;
    $('simulationLoad').hidden=!!data || busy || !plan;
    $('simulationControls').querySelectorAll('button,select').forEach(el=>{el.disabled=busy;});
    if (!data) { $('simulationResults').innerHTML=''; return; }
    const strategy=$('simulationStrategy'), selected=strategy.value;
    strategy.innerHTML='<option value="">跟隨當下推薦</option>'+data.routes.map(r=>`<option value="${r.key}">全部自行選擇${esc(r.label)}</option>`).join('');
    if (data.routes.some(r=>r.key===selected)) strategy.value=selected;
    const winner=data.routes.find(r=>r.recommended);
    const eligibleCount=data.routes.filter(r=>r.model?.eligible).length;
    $('simulationResults').innerHTML=`<div class="sim-metrics"><div><span>模擬時間</span><strong>${data.minute}<small> 分鐘</small></strong></div><div><span>有效虛擬人數</span><strong>${data.active}<small> 人</small></strong></div><div><span>累計加入／到期</span><strong>${data.issued}<small>／${data.expired}</small></strong></div></div>
      <div class="sim-next"><strong>${winner ? `下一位建議：${esc(winner.label)}` : '目前沒有符合條件的自動推薦'}</strong><p>${winner ? winner.reasons.map(esc).join('；') : '可指定路線模擬自行選擇，或回主畫面更換路線／模式。'}</p>${eligibleCount===1 ? '<p class="coverage-note">目前只有一條路線符合推薦條件，跟隨推薦的使用者都會選擇它；人數增加不會放寬安全與時間門檻。</p>' : ''}</div>
      <div class="sim-route-grid">${data.routes.map((r,i)=>`<article class="sim-route ${r.recommended ? 'is-recommended' : ''}" style="--route-color:${COLORS[i]}"><header><strong>${esc(r.label)}</strong><button type="button" data-sim-map="${r.index}">查看地圖 ↗</button></header><div class="sim-route-count">${r.count}<small> 位虛擬使用者</small></div><div class="sim-bar" role="img" aria-label="${esc(r.label)} ${r.count} 人，占 ${data.active ? Math.round(r.count/data.active*100) : 0}%"><span style="width:${data.active ? r.count/data.active*100 : 0}%"></span></div><p>時間 ${num(r.expectedMin)} 分鐘${data.config.riskWeight ? ` · 安全 ${num(r.safety?.score)} 分` : ''}</p><dl><div><dt>分流成本</dt><dd>${num(r.model?.loadCost,3)}</dd></div><div><dt>總推薦成本</dt><dd>${num(r.model?.total,3)}</dd></div><div><dt>下一位推薦權重</dt><dd>${num((r.model?.probability ?? 0)*100)}%</dd></div></dl>${!r.model?.eligible ? `<p class="sim-excluded">${esc(r.reasons.find(reason=>reason.includes('未列入')) || '不符合自動推薦條件')}</p>` : ''}</article>`).join('')}</div>
      <p class="sim-note">推薦權重用來分配下一位的建議；人數改變推薦成本，預估時間與安全分數維持原值。參考額度為每條 20 人，並非實際道路容量。</p>
      ${data.users.length ? `<details class="sim-users"><summary>查看使用者／模擬改選（最近 ${data.users.length} 位有效使用者）</summary><div class="sim-user-list">${data.users.map(u=>`<div><span>${esc(u.userId)}<small>第 ${u.expiresAt} 分鐘到期</small></span><select aria-label="${esc(u.userId)} 改選路線" data-sim-user="${esc(u.userId)}" ${busy?'disabled':''}>${data.routes.map(r=>`<option value="${r.key}" ${r.key===u.routeKey?'selected':''}>${esc(r.label)}</option>`).join('')}</select></div>`).join('')}</div></details>` : ''}
      <details class="sim-log" open><summary>選擇紀錄與當時推薦原因</summary><div>${data.events.length ? data.events.map(e=>{
        const label=key=>esc(data.routes.find(r=>r.key===key)?.label || '');
        return `<article><strong>第 ${e.minute} 分鐘 · ${e.kind==='expire' ? `釋放 ${e.released} 位到期使用者` : e.kind==='switch' ? `${esc(e.userId)}：${label(e.previousRoute)} → ${label(e.routeKey)}` : `${esc(e.userId)} 選擇${esc(e.label)} · ${e.manual?'自行選路':'採用推薦'}`}</strong>${e.reasons?`<p>${e.reasons.map(esc).join('；')}。當時權重 ${num((e.probability??0)*100)}%，成本 ${num(e.cost,3)}。</p>`:''}</article>`;
      }).join('') : '<p>加入虛擬使用者後，這裡會記錄每次選擇及推薦原因。</p>'}</div></details>`;
  }
  async function act(action,body={}) {
    const plan=getPlan(); if (!plan || busy) return;
    const id=plan.planId, version=++epoch;
    const usersOpen=$('simulationResults').querySelector('.sim-users')?.open;
    busy=true; error=''; render();
    try {
      const result=await request('simulation',{planId:id,action,...body});
      if (epoch!==version || getPlan()?.planId!==id) return;
      data=result; planId=id;
    } catch(e) { if(epoch===version) error=e.message; }
    finally { if(epoch===version) { busy=false;render(); if(usersOpen && $('simulationResults').querySelector('.sim-users')) $('simulationResults').querySelector('.sim-users').open=true; } }
  }
  async function open() {
    dialog.showModal(); render();
    await prepare();
    if (!dialog.open) return;
    if (planId!==getPlan()?.planId) invalidate();
    if (getPlan()) await act('snapshot'); else render();
  }
  $('routeSimulationClose').addEventListener('click',()=>dialog.close());
  $('simulationLoad').addEventListener('click',()=>act('snapshot'));
  $('simulationControls').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.simAdd) act('add',{count:Number(b.dataset.simAdd),routeKey:$('simulationStrategy').value || null});
    if(b.dataset.simAdvance) act('advance',{minutes:Number(b.dataset.simAdvance)});
    if(b.hasAttribute('data-sim-reset')) act('reset');
  });
  $('simulationResults').addEventListener('change',e=>{
    if(e.target.dataset.simUser) act('switch',{userId:e.target.dataset.simUser,routeKey:e.target.value});
  });
  $('simulationResults').addEventListener('click',e=>{
    const b=e.target.closest('[data-sim-map]');if(b){selectRoute(Number(b.dataset.simMap));dialog.close();}
  });
  return {open,invalidate};
}
