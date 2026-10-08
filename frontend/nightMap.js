const EMPTY = { type:'FeatureCollection',features:[] };
const TYPES = [{ key:'streetlights',color:'#ffd36a',label:'路燈' },{ key:'stores',color:'#5ce0b1',label:'便利商店' }];

export function createNightMap({ map,mapReady,Popup,request }) {
  const $ = id => document.getElementById(id);
  let enabled = false, ready = false, current = null, lastKey = '', revision = 0, controller, popup;
  const cache = new Map();
  function visibility() {
    for (const {key} of TYPES) for (const suffix of ['points','clusters','counts']) {
      const id = `night-${key}-${suffix}`;
      if (map.getLayer(id)) map.setLayoutProperty(id,'visibility',enabled && $(`night-${key}`).checked ? 'visible' : 'none');
    }
    popup?.remove();
  }
  for (const {key} of TYPES) $(`night-${key}`).addEventListener('change',visibility);
  $('nightMapRetry').addEventListener('click',() => { lastKey = ''; update(current); });
  mapReady.then(() => {
    for (const {key,color,label} of TYPES) {
      const source = `night-${key}`;
      map.addSource(source,{ type:'geojson',data:EMPTY,cluster:true,clusterMaxZoom:14,clusterRadius:key === 'streetlights' ? 32 : 24 });
      map.addLayer({ id:`${source}-clusters`,type:'circle',source,filter:['has','point_count'],
        paint:{ 'circle-color':color,'circle-radius':['step',['get','point_count'],12,20,16,100,20],'circle-opacity':0.86,'circle-stroke-width':1.5,'circle-stroke-color':'#192638' } });
      map.addLayer({ id:`${source}-counts`,type:'symbol',source,filter:['has','point_count'],
        layout:{ 'text-field':['get','point_count_abbreviated'],'text-font':['Noto Sans Regular'],'text-size':11 },paint:{ 'text-color':'#11212b' } });
      map.addLayer({ id:`${source}-points`,type:'circle',source,filter:['!',['has','point_count']],
        paint:{ 'circle-color':color,'circle-radius':key === 'streetlights' ? ['interpolate',['linear'],['zoom'],12,3,17,5] : 7,
          'circle-opacity':0.92,'circle-stroke-width':key === 'stores' ? 2 : 1,'circle-stroke-color':key === 'stores' ? '#e6fff3' : '#4f421f' } });
      for (const suffix of ['points','clusters']) {
        const layer = `${source}-${suffix}`;
        map.on('mouseenter',layer,() => { map.getCanvas().style.cursor='pointer'; });
        map.on('mouseleave',layer,() => { map.getCanvas().style.cursor=''; });
        map.on('click',layer,async e => {
          const feature = e.features?.[0]; if (!feature) return;
          if (suffix === 'clusters') {
            const zoom = await map.getSource(source).getClusterExpansionZoom(feature.properties.cluster_id);
            map.easeTo({ center:feature.geometry.coordinates,zoom }); return;
          }
          const p = feature.properties, content = document.createElement('div'); content.className='night-point-popup';
          const title=document.createElement('strong');title.textContent=p.name || label;content.append(title);
          for (const text of [p.brand,p.address,p.distanceMeters != null ? `距路線約 ${p.distanceMeters} 公尺` : '',
            key === 'streetlights' ? '登記點位，不代表目前亮燈。' : '營業時間與現場狀態請以店家為準。']) {
            if (!text) continue; const line=document.createElement('p');line.textContent=text;content.append(line);
          }
          popup?.remove(); popup=new Popup({ closeButton:true,maxWidth:'270px' }).setLngLat(feature.geometry.coordinates).setDOMContent(content).addTo(map);
        });
      }
    }
    ready = true; lastKey = ''; update(current);
  });
  function clear() {
    if (ready) for (const {key} of TYPES) map.getSource(`night-${key}`).setData(EMPTY);
    popup?.remove();
  }
  function show(data) {
    for (const {key} of TYPES) {
      map.getSource(`night-${key}`).setData(data[key]);
      $(`night-${key}-count`).textContent = data[key].truncated ? `${data[key].shown}／${data[key].total}` : `${data[key].total}`;
      for (const suffix of ['clusters','counts','points']) map.moveLayer(`night-${key}-${suffix}`);
    }
    const missing = data.coverage?.status?.streetlight;
    $('nightMapStatus').textContent = `${data.note} ${missing === 'no-data' ? '此區缺少完整路燈資料，沒有標記不表示沒有路燈。' : missing === 'partial' ? '此路線路燈資料僅部分涵蓋。' : ''}`;
    $('nightMapDetail').textContent = TYPES.some(({key}) => data[key].truncated) ? '點位較多，顯示部分代表點；評分仍採完整資料。' : '數字圓圈為合併點位，點擊可放大。';
  }
  async function update(state) {
    current = state; enabled = !!state?.night;
    $('nightMapPanel').hidden = !enabled; visibility();
    if (!enabled || !state?.row || !state.planId) {
      if (lastKey) { revision++; controller?.abort(); lastKey=''; }
      clear(); $('nightMapTitle').textContent='夜間環境圖層';
      $('nightMapStatus').textContent=enabled ? '規劃並分析路線後，顯示沿途路燈與便利商店。' : '';
      for (const {key} of TYPES) $(`night-${key}-count`).textContent='—';
      $('nightMapRetry').hidden=true; $('nightMapDetail').textContent=''; return;
    }
    const key=`${state.planId}:${state.row.key}`;
    if (key === lastKey || !ready) return;
    lastKey=key; const epoch=++revision; controller?.abort(); controller=new AbortController(); clear();
    $('nightMapTitle').textContent=`${state.row.label} · 夜間環境`;
    $('nightMapStatus').textContent='載入沿途點位…'; $('nightMapRetry').hidden=true;
    for (const {key} of TYPES) $(`night-${key}-count`).textContent='…';
    try {
      const data=cache.get(key) || await request('map-points',{ planId:state.planId,routeKey:state.row.key },controller.signal);
      if (epoch !== revision) return;
      if (cache.size >= 5) cache.delete(cache.keys().next().value);
      cache.set(key,data); show(data);
    } catch(e) {
      if (epoch !== revision || e.name === 'AbortError') return;
      $('nightMapStatus').textContent=e.message; $('nightMapRetry').hidden=false;
      for (const {key} of TYPES) $(`night-${key}-count`).textContent='—';
    }
  }
  return { update };
}
