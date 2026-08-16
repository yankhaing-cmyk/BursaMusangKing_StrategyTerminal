const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const labels={trending:'Trending',gaining_momentum:'Momentum',meta_leader:'M.E.T.A.'};
const strategyOrder=['trending','gaining_momentum','meta_leader'];
const eventLabels={BUY_SIGNAL:'BUY SIGNAL',ENTRY_CONFIRMED:'ENTRY CONFIRMED',NEAR_SELL:'NEAR SELL',SELL:'SELL'};
const stateLabels={FLAT:'FLAT',BUY_PENDING:'BUY SIGNAL',OPEN:'ENTRY CONFIRMED',NEAR_SELL:'NEAR SELL',CLOSED:'SELL'};
let state={dash:null,positions:[],events:[],trades:[],performance:[],health:null,eventFilter:'ALL',strategyFilter:'ALL',historyFilter:'ALL'};

const api=async p=>{const r=await fetch(p,{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error||r.statusText);return j};
const money=n=>Number.isFinite(Number(n))?'RM '+Number(n).toFixed(3):'—';
const bursaTick=v=>v<1?0.005:v<10?0.01:v<100?0.02:0.10;
const atrMoney=n=>{
  const v=Number(n);
  if(!Number.isFinite(v))return '—';
  let tick=bursaTick(v);
  let rounded=Math.round((v+Number.EPSILON)/tick)*tick;
  const tick2=bursaTick(rounded);
  if(tick2!==tick){tick=tick2;rounded=Math.round((v+Number.EPSILON)/tick)*tick}
  return 'RM '+rounded.toFixed(rounded<1?3:2)
};
const pct=n=>Number.isFinite(Number(n))?Number(n).toFixed(2)+'%':'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MANUAL_RUN_URL='https://github.com/yankhaing-cmyk/BursaMusangKing_StrategyTerminal/actions/workflows/strategy-scan.yml';
const THEME_KEY='bursa-theme';

const formatMYT=iso=>{
  if(!iso)return 'Last update —';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return 'Last update —';
  return 'Last update '+new Intl.DateTimeFormat('en-MY',{
    timeZone:'Asia/Kuala_Lumpur',day:'2-digit',month:'short',year:'numeric',
    hour:'2-digit',minute:'2-digit',hour12:true
  }).format(d)+' MYT'
};

function applyTheme(theme){
  const t=theme==='light'?'light':'dark';
  document.documentElement.dataset.theme=t;
  document.documentElement.style.colorScheme=t;
  localStorage.setItem(THEME_KEY,t);
  const b=$('#themeToggle');
  if(b){
    b.textContent=t==='dark'?'☀':'☾';
    b.title=t==='dark'?'Switch to day mode':'Switch to night mode';
    b.setAttribute('aria-label',b.title)
  }
  const meta=document.querySelector('meta[name=theme-color]');
  if(meta)meta.content=t==='dark'?'#07111e':'#f4f7fb'
}

function initTheme(){
  const saved=localStorage.getItem(THEME_KEY);
  const preferred=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
  applyTheme(saved||preferred)
}

function sameCycle(a,b){
  return a&&b&&a.strategy===b.strategy&&a.symbol===b.symbol&&Number(a.cycle||0)===Number(b.cycle||0)
}

function previousEvent(x,todayEvents=[]){
  const idx=todayEvents.indexOf(x);
  if(idx>0){
    for(let i=idx-1;i>=0;i--){
      const e=todayEvents[i];
      if(sameCycle(e,x)&&String(e.trade_date||'')===String(x.trade_date||''))return e
    }
  }

  const date=String(x.trade_date||'');
  let best=null;
  for(const e of state.events||[]){
    if(!sameCycle(e,x))continue;
    const ed=String(e.trade_date||'');
    if(!ed||ed>=date)continue;
    if(!best||ed>String(best.trade_date||''))best=e
  }
  return best
}

function lifecycleInfo(x,todayEvents=[]){
  if(String(x.message||'').startsWith('Historical bootstrap:')){
    return {kind:'',transition:''}
  }

  if(x.event_type==='BUY_SIGNAL'){
    return {kind:'NEW',transition:''}
  }

  if(x.from_status&&x.to_status&&x.from_status!==x.to_status){
    const from=stateLabels[x.from_status]||String(x.from_status).replaceAll('_',' ');
    const to=stateLabels[x.to_status]||eventLabels[x.event_type]||String(x.event_type).replaceAll('_',' ');
    return {kind:'CHANGED',transition:`${from} → ${to}`}
  }

  const prev=previousEvent(x,todayEvents);
  if(prev&&prev.event_type!==x.event_type){
    const from=eventLabels[prev.event_type]||String(prev.event_type).replaceAll('_',' ');
    const to=eventLabels[x.event_type]||String(x.event_type).replaceAll('_',' ');
    return {kind:'CHANGED',transition:`${from} → ${to}`}
  }
  return {kind:'',transition:''}
}

async function load(){
  try{
    const [d,p,e,t,h]=await Promise.all([
      api('/api/dashboard'),api('/api/positions'),api('/api/events'),api('/api/trades'),api('/api/health')
    ]);
    state={...state,dash:d,positions:p.positions,events:e.events,trades:t.trades,performance:t.performance,health:h};
    render()
  }catch(e){
    $('#runState').textContent='ERROR · '+e.message;
    $('#todayList').innerHTML=`<div class="empty">${esc(e.message)}</div>`
  }
}

function render(){renderToday();renderOpen();renderHistory();renderPerf();renderHealth()}

function renderToday(){
  const d=state.dash||{};
  const m=Object.fromEntries((d.counts||[]).map(x=>[x.event_type,Number(x.n)]));

  $('#runState').textContent=d.last_run?`${d.last_run.stocks_screened} stocks · ${d.last_run.trade_date} · ${d.last_run.status}`:'No verified scan yet';
  $('#lastUpdated').textContent=d.last_run?formatMYT(d.last_run.generated_at):'Last update —';

  $('#stats').innerHTML=[
    ['New Buy',m.BUY_SIGNAL||0],
    ['Sell',m.SELL||0],
    ['Near Sell',m.NEAR_SELL||0],
    ['Unread',d.unread||0]
  ].map(x=>`<div class="stat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');

  const c=d.confluence||[];
  $('#confluence').innerHTML=c.length
    ?c.map(x=>`<div class="card"><div class="top"><div><div class="ticker">🔥 ${esc(x.symbol.replace('.KL',''))}</div><div class="name">${esc(x.name)}</div></div><div class="badge BUY_SIGNAL">${x.confluence}/3 BUY</div></div><div class="msg">${esc(x.strategies.split(',').map(s=>labels[s]||s).join(' · '))}</div></div>`).join('')
    :'<div class="empty">No multi-strategy buys today.</div>';

  const allEvents=d.events||[];
  const filtered=allEvents.filter(x=>state.eventFilter==='ALL'||x.event_type===state.eventFilter);
  $('#todayList').innerHTML=strategyOrder.map(strategy=>strategyGroup(strategy,filtered,allEvents)).join('')
}

function strategyGroup(strategy,filtered,allEvents){
  const visible=filtered.filter(x=>x.strategy===strategy);
  const all=allEvents.filter(x=>x.strategy===strategy);
  const buy=all.filter(x=>x.event_type==='BUY_SIGNAL').length;
  const sell=all.filter(x=>x.event_type==='SELL').length;
  const near=all.filter(x=>x.event_type==='NEAR_SELL').length;
  const entry=all.filter(x=>x.event_type==='ENTRY_CONFIRMED').length;
  const lifecycle=all.map(x=>lifecycleInfo(x,allEvents));
  const newCount=lifecycle.filter(x=>x.kind==='NEW').length;
  const changedCount=lifecycle.filter(x=>x.kind==='CHANGED').length;
  const activeFilter=state.eventFilter==='ALL'?'All':state.eventFilter.replaceAll('_',' ');

  return `<section class="strategy-group strategy-${esc(strategy)}">
    <div class="strategy-head">
      <div>
        <div class="strategy-title">${esc(labels[strategy]||strategy)}</div>
        <div class="strategy-sub">${all.length} event${all.length===1?'':'s'} today · showing ${esc(activeFilter)}</div>
        <div class="strategy-delta"><b>New ${newCount}</b><span>·</span><b>Changed ${changedCount}</b></div>
      </div>
      <div class="strategy-mini-counts">
        <span class="mini-buy">B ${buy}</span>
        <span class="mini-sell">S ${sell}</span>
        <span class="mini-near">N ${near}</span>
        ${entry?`<span class="mini-entry">E ${entry}</span>`:''}
      </div>
    </div>
    <div class="stack">
      ${visible.length?visible.map(x=>eventCard(x,lifecycleInfo(x,allEvents))).join(''):`<div class="empty compact">No matching ${esc(labels[strategy]||strategy)} signals.</div>`}
    </div>
  </section>`
}

function eventCard(x,life=null){
  const lifecycle=life?.kind?`<span class="delta-badge delta-${life.kind.toLowerCase()}">${life.kind}</span>`:'';
  const transition=life?.transition?`<div class="transition">${esc(life.transition)}</div>`:'';
  return `<div class="card ${x.reviewed?'':'unread'}">
    <div class="top">
      <div>
        <div class="ticker">${esc(x.symbol.replace('.KL',''))}</div>
        <div class="name">${esc(x.name)}</div>
      </div>
      <div class="price">
        ${money(x.price)}
        <div class="badge-row">${lifecycle}<span class="badge ${x.event_type}">${esc((eventLabels[x.event_type]||x.event_type).replace('_',' '))}</span></div>
      </div>
    </div>
    <div class="meta">
      <div class="kv"><span>Entry</span><b>${money(x.entry_price)}</b></div>
      <div class="kv"><span>ATR stop</span><b>${atrMoney(x.atr_stop)}</b></div>
      <div class="kv"><span>Return</span><b>${pct(x.return_pct)}</b></div>
    </div>
    ${transition}
    <div class="msg">${esc(x.message)}</div>
  </div>`
}

function renderOpen(){
  let a=state.positions.filter(x=>state.strategyFilter==='ALL'||x.strategy===state.strategyFilter);
  const q=($('#openSearch')?.value||'').toLowerCase();
  if(q)a=a.filter(x=>x.symbol.toLowerCase().includes(q)||x.name.toLowerCase().includes(q));
  $('#openList').innerHTML=a.length?a.map(x=>`<div class="card"><div class="top"><div><div class="ticker">${esc(x.symbol.replace('.KL',''))}</div><div class="name">${esc(x.name)} · ${esc(labels[x.strategy]||x.strategy)}</div></div><div class="badge ${x.status==='NEAR_SELL'?'NEAR_SELL':'ENTRY_CONFIRMED'}">${esc(x.status)}</div></div><div class="meta"><div class="kv"><span>Entry</span><b>${money(x.entry_price)}</b></div><div class="kv"><span>Latest</span><b>${money(x.latest_close)}</b></div><div class="kv"><span>ATR stop</span><b>${atrMoney(x.atr_stop)}</b></div><div class="kv"><span>Signal</span><b>${esc(x.signal_date||'—')}</b></div><div class="kv"><span>Entry date</span><b>${esc(x.entry_date||'Pending')}</b></div><div class="kv"><span>Held</span><b>${x.hold_days||0}d</b></div></div></div>`).join(''):'<div class="empty">No matching active strategy states.</div>'
}

function renderHistory(){
  let a=state.events.filter(x=>state.historyFilter==='ALL'||x.strategy===state.historyFilter);
  const q=($('#historySearch')?.value||'').toLowerCase();
  if(q)a=a.filter(x=>x.symbol.toLowerCase().includes(q)||x.name.toLowerCase().includes(q));
  $('#historyList').innerHTML=a.length?a.slice(0,500).map(x=>eventCard(x)).join(''):'<div class="empty">No matching signal history.</div>'
}

function renderPerf(){
  const p=state.performance||[];
  $('#perfCards').innerHTML=p.length?p.map(x=>`<div class="card"><div class="top"><div class="ticker">${esc(labels[x.strategy]||x.strategy)}</div><div class="price">PF ${x.profit_factor==null?'—':Number(x.profit_factor).toFixed(2)}</div></div><div class="meta"><div class="kv"><span>Trades</span><b>${x.trades}</b></div><div class="kv"><span>Win rate</span><b>${Number(x.win_rate).toFixed(1)}%</b></div><div class="kv"><span>Avg return</span><b>${pct(x.avg_return)}</b></div></div></div>`).join(''):'<div class="empty">Forward performance begins after live strategy exits are recorded.</div>';
  $('#tradeList').innerHTML=state.trades.length?state.trades.slice(0,200).map(x=>`<div class="card"><div class="top"><div><div class="ticker">${esc(x.symbol.replace('.KL',''))}</div><div class="name">${esc(labels[x.strategy]||x.strategy)} · ${esc(x.entry_date)} → ${esc(x.exit_date)}</div></div><div class="price ${x.return_pct>=0?'BUY_SIGNAL':'SELL'}">${pct(x.return_pct)}</div></div></div>`).join(''):'<div class="empty">No closed live trades yet.</div>'
}

function renderHealth(){
  const h=state.health||{},r=h.last_run;
  $('#healthCard').innerHTML=r?`<div class="card"><div class="top"><div><div class="ticker">${r.status==='OK'?'✅':'⚠️'} Latest verified run</div><div class="name">${esc(formatMYT(r.generated_at))}</div></div><div class="badge ${r.status==='OK'?'BUY_SIGNAL':'SELL'}">${esc(r.status)}</div></div><div class="meta"><div class="kv"><span>Trade date</span><b>${esc(r.trade_date)}</b></div><div class="kv"><span>Screened</span><b>${r.stocks_screened}</b></div><div class="kv"><span>Rows</span><b>${r.rows_received}</b></div><div class="kv"><span>Active states</span><b>${h.active_states}</b></div><div class="kv"><span>Min universe</span><b>${h.min_universe}</b></div><div class="kv"><span>Message</span><b>${esc(r.message)}</b></div></div></div>`:'<div class="empty">No successful full-market publish yet.</div>'
}

$$('[data-nav]').forEach(b=>b.onclick=()=>{
  $$('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===b.dataset.nav));
  $$('[data-nav]').forEach(x=>x.classList.toggle('on',x===b));
  scrollTo(0,0)
});
$$('[data-event]').forEach(b=>b.onclick=()=>{
  state.eventFilter=b.dataset.event;
  $$('[data-event]').forEach(x=>x.classList.toggle('on',x===b));
  renderToday()
});
$$('[data-strategy]').forEach(b=>b.onclick=()=>{
  state.strategyFilter=b.dataset.strategy;
  $$('[data-strategy]').forEach(x=>x.classList.toggle('on',x===b));
  renderOpen()
});
$$('[data-history]').forEach(b=>b.onclick=()=>{
  state.historyFilter=b.dataset.history;
  $$('[data-history]').forEach(x=>x.classList.toggle('on',x===b));
  renderHistory()
});

$('#openSearch').oninput=renderOpen;
$('#historySearch').oninput=renderHistory;
$('#refresh').onclick=load;
$('#themeToggle').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');
$('#manualRun').onclick=()=>window.open(MANUAL_RUN_URL,'_blank','noopener,noreferrer');
$('#reviewAll').onclick=async()=>{await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:'{"all":true}'});await load()};

initTheme();
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
load();
setInterval(load,300000);
