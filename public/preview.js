const pe=s=>document.querySelector(s);
const pesc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plabels={trending:'Trending',gaining_momentum:'Momentum',meta_leader:'M.E.T.A.'};
const pEvent={BUY_SIGNAL:'BUY',ENTRY_CONFIRMED:'ENTRY',NEAR_SELL:'NEAR SELL',SELL:'SELL'};
const pMoney=n=>Number.isFinite(Number(n))?'RM '+Number(n).toFixed(3):'—';
const pPct=n=>Number.isFinite(Number(n))?`${Number(n)>=0?'+':''}${Number(n).toFixed(2)}%`:'—';

function pTime(iso){
  if(!iso)return 'No preview yet';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return 'No preview yet';
  return new Intl.DateTimeFormat('en-MY',{
    timeZone:'Asia/Kuala_Lumpur',
    day:'2-digit',month:'short',
    hour:'2-digit',minute:'2-digit',hour12:true
  }).format(d)+' MYT';
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

async function loadPreview(){
  const stamp=pe('#previewStamp'),panel=pe('#previewPanel');
  if(!stamp||!panel)return;
  try{
    const r=await fetch('/api/preview',{cache:'no-store'});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||r.statusText);
    const p=j.preview;

    if(!p){
      stamp.textContent='No preview yet';
      panel.innerHTML='<div class="empty">The 12:45 PM preview or a manual Run has not completed yet.</div>';
      return;
    }

    stamp.textContent=`${p.trade_date} · ${pTime(p.generated_at)}`;
    const b=p.breadth||{},h=p.hit_counts||{},ec=p.event_counts||{};
    const breadth=`<div class="stats" style="margin:3px 0 12px">
      <div class="stat"><b>${Number(p.rows_received||0)}</b><span>Current bars</span></div>
      <div class="stat"><b>${Number(b.advancers||0)}</b><span>Advancers</span></div>
      <div class="stat"><b>${Number(b.decliners||0)}</b><span>Decliners</span></div>
      <div class="stat"><b>${pPct(b.median_change_pct)}</b><span>Median move</span></div>
    </div>`;

    const strategy=`<div class="card">
      <div class="top">
        <div>
          <div class="ticker">Strategy breadth</div>
          <div class="name">${Number(p.rows_received||0)}/${Number(p.stocks_screened||0)} valid current-date bars · ${Number(p.stale_or_nontrading||0)} stale/non-trading</div>
        </div>
        <div class="badge BUY_SIGNAL">PREVIEW</div>
      </div>
      <div class="meta">
        <div class="kv"><span>Trending</span><b>${Number(h.trending||0)}</b></div>
        <div class="kv"><span>Momentum</span><b>${Number(h.gaining_momentum||0)}</b></div>
        <div class="kv"><span>M.E.T.A.</span><b>${Number(h.meta_leader||0)}</b></div>
        <div class="kv"><span>Potential Buy</span><b>${Number(ec.BUY_SIGNAL||0)}</b></div>
        <div class="kv"><span>Near Sell</span><b>${Number(ec.NEAR_SELL||0)}</b></div>
        <div class="kv"><span>Potential Sell</span><b>${Number(ec.SELL||0)}</b></div>
      </div>
    </div>`;

    const events=(p.events||[]).slice(0,30);
    const eventHtml=events.length
      ?`<div class="strategy-sub" style="margin:12px 0 8px">Potential state changes · preview only</div>${events.map(pCard).join('')}`
      :'<div class="empty compact">No potential state changes in this preview.</div>';

    panel.innerHTML=breadth+strategy+eventHtml;
  }catch(e){
    stamp.textContent='Preview error';
    panel.innerHTML=`<div class="empty">${pesc(e.message)}</div>`;
  }
}

loadPreview();
setInterval(loadPreview,60000);
