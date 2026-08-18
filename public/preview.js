const pe=s=>document.querySelector(s);
const pesc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plabels={trending:'Trending',gaining_momentum:'Momentum',meta_leader:'M.E.T.A.'};
const pEvent={BUY_SIGNAL:'BUY',ENTRY_CONFIRMED:'ENTRY',NEAR_SELL:'NEAR SELL',SELL:'SELL'};
const pMoney=n=>Number.isFinite(Number(n))?'RM '+Number(n).toFixed(Number(n)<1?3:2):'—';
const pPct=n=>Number.isFinite(Number(n))?`${Number(n)>=0?'+':''}${Number(n).toFixed(2)}%`:'—';
let pRawStrategy='gaining_momentum';
let pLast=null;

function pTime(iso){
  if(!iso)return 'No scan yet';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return 'No scan yet';
  return new Intl.DateTimeFormat('en-MY',{
    timeZone:'Asia/Kuala_Lumpur',
    day:'2-digit',month:'short',
    hour:'2-digit',minute:'2-digit',hour12:true
  }).format(d)+' MYT';
}

function rawCard(x){
  const sym=String(x.symbol||'').replace('.KL','');
  return `<div class="card">
    <div class="top">
      <div><div class="ticker">${pesc(sym)}</div><div class="name">${pesc(x.name||'')}</div></div>
      <div class="price">${pMoney(x.close)}</div>
    </div>
    <div class="meta">
      <div class="kv"><span>RSI</span><b>${Number.isFinite(Number(x.rsi))?Number(x.rsi).toFixed(1):'—'}</b></div>
      <div class="kv"><span>ADX</span><b>${Number.isFinite(Number(x.adx))?Number(x.adx).toFixed(1):'—'}</b></div>
      <div class="kv"><span>Vol</span><b>${Number.isFinite(Number(x.vol_ratio))?Number(x.vol_ratio).toFixed(2)+'×':'—'}</b></div>
    </div>
  </div>`;
}

function pCard(e){
  return `<div class="card">
    <div class="top">
      <div>
        <div class="ticker">${pesc(String(e.symbol||'').replace('.KL',''))}</div>
        <div class="name">${pesc(e.name||'')} · ${pesc(plabels[e.strategy]||e.strategy)}</div>
      </div>
      <div class="price">
        ${pMoney(e.price)}
        <div class="badge-row"><span class="badge ${pesc(e.event_type)}">PREVIEW ${pesc(pEvent[e.event_type]||e.event_type)}</span></div>
      </div>
    </div>
    <div class="msg">${pesc(e.message||'')}</div>
  </div>`;
}

function rawScreenerHtml(s){
  if(!s)return '<div class="empty">No raw screener scan yet.</div>';
  const counts=s.counts||{},hits=s.hits||{};
  const tabs=['trending','gaining_momentum','meta_leader'].map(st=>
    `<button class="${st===pRawStrategy?'on':''}" data-raw-strategy="${st}">${pesc(plabels[st])} ${Number(counts[st]||0)}</button>`
  ).join('');
  const rows=Array.isArray(hits[pRawStrategy])?hits[pRawStrategy]:[];
  const source=s.source==='official'?'OFFICIAL':'PREVIEW';
  return `<div class="strategy-sub" style="margin:2px 0 8px">Raw screener · exact BursaMusangKing scan() output · ${source} · ${pTime(s.generated_at)}</div>
    <div class="strategy-tabs" style="margin-bottom:10px">${tabs}</div>
    <div class="stack">${rows.length?rows.map(rawCard).join(''):`<div class="empty compact">No ${pesc(plabels[pRawStrategy])} matches.</div>`}</div>`;
}

function renderPreview(j){
  const stamp=pe('#previewStamp'),panel=pe('#previewPanel');
  if(!stamp||!panel)return;
  const p=j.preview;
  const s=j.screener;
  stamp.textContent=s?`${s.trade_date} · ${pTime(s.generated_at)}`:(p?`${p.trade_date} · ${pTime(p.generated_at)}`:'No scan yet');

  let lifecycle='';
  if(p){
    const b=p.breadth||{},h=p.hit_counts||{},ec=p.event_counts||{};
    const breadth=`<div class="stats" style="margin:14px 0 12px">
      <div class="stat"><b>${Number(p.rows_received||0)}</b><span>Current bars</span></div>
      <div class="stat"><b>${Number(b.advancers||0)}</b><span>Advancers</span></div>
      <div class="stat"><b>${Number(b.decliners||0)}</b><span>Decliners</span></div>
      <div class="stat"><b>${pPct(b.median_change_pct)}</b><span>Median move</span></div>
    </div>`;
    const strategy=`<div class="card">
      <div class="top">
        <div><div class="ticker">Strategy lifecycle preview</div><div class="name">${Number(p.rows_received||0)}/${Number(p.stocks_screened||0)} valid current-date bars · ${Number(p.stale_or_nontrading||0)} stale/non-trading</div></div>
        <div class="badge BUY_SIGNAL">PREVIEW</div>
      </div>
      <div class="meta">
        <div class="kv"><span>Trending raw</span><b>${Number(h.trending||0)}</b></div>
        <div class="kv"><span>Momentum raw</span><b>${Number(h.gaining_momentum||0)}</b></div>
        <div class="kv"><span>M.E.T.A. raw</span><b>${Number(h.meta_leader||0)}</b></div>
        <div class="kv"><span>Potential Buy</span><b>${Number(ec.BUY_SIGNAL||0)}</b></div>
        <div class="kv"><span>Near Sell</span><b>${Number(ec.NEAR_SELL||0)}</b></div>
        <div class="kv"><span>Potential Sell</span><b>${Number(ec.SELL||0)}</b></div>
      </div>
    </div>`;
    const events=(p.events||[]).slice(0,30);
    const eventHtml=events.length
      ?`<div class="strategy-sub" style="margin:12px 0 8px">Potential state changes · preview only</div>${events.map(pCard).join('')}`
      :'<div class="empty compact">No potential state changes in this preview.</div>';
    lifecycle=breadth+strategy+eventHtml;
  }

  panel.innerHTML=rawScreenerHtml(s)+lifecycle;
  panel.querySelectorAll('[data-raw-strategy]').forEach(b=>{
    b.onclick=()=>{pRawStrategy=b.dataset.rawStrategy;renderPreview(j)};
  });
}

async function loadPreview(){
  const stamp=pe('#previewStamp'),panel=pe('#previewPanel');
  if(!stamp||!panel)return;
  try{
    const r=await fetch('/api/preview',{cache:'no-store'});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||r.statusText);
    pLast=j;
    renderPreview(j);
  }catch(e){
    stamp.textContent='Preview error';
    panel.innerHTML=`<div class="empty">${pesc(e.message)}</div>`;
  }
}

loadPreview();
setInterval(loadPreview,60000);
