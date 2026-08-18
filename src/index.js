import { STRATEGIES, processState } from './engine.js';

const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const GH_REPO='yankhaing-cmyk/BursaMusangKing_StrategyTerminal';
const GH_WORKFLOW='strategy-scan.yml';

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    try{
      if(url.pathname==='/api/health') return await health(env);
      if(url.pathname==='/api/dashboard') return await dashboard(env,url);
      if(url.pathname==='/api/events') return await eventsApi(env,url);
      if(url.pathname==='/api/positions') return await positionsApi(env,url);
      if(url.pathname==='/api/trades') return await tradesApi(env,url);
      if(url.pathname==='/api/preview'&&request.method==='GET') return await previewApi(env);
      if(url.pathname==='/api/preview'&&request.method==='POST') return await publishPreview(request,env);
      if(url.pathname==='/api/manual-run'&&request.method==='POST') return await manualRun(request,env);
      if(url.pathname==='/api/review'&&request.method==='POST') return await markReviewed(env);
      if(url.pathname==='/api/publish'&&request.method==='POST') return await publishSnapshot(request,env);
      if(url.pathname==='/api/bootstrap'&&request.method==='POST') return await bootstrapSnapshot(request,env,url);
      return env.ASSETS.fetch(request);
    }catch(e){
      console.error(e);
      return json({ok:false,error:e?.message||String(e)},e?.status||500);
    }
  }
};

async function health(env){
  const [run,snaps,boot,previewRaw]=await Promise.all([
    env.DB.prepare('SELECT id,generated_at,trade_date,stocks_screened,rows_received,status,message,created_at FROM daily_runs ORDER BY trade_date DESC LIMIT 1').first(),
    env.DB.prepare('SELECT strategy,trade_date,length(state_json) bytes FROM strategy_snapshots ORDER BY strategy').all(),
    setting(env,'bootstrapped','0'),
    setting(env,'latest_preview_json','')
  ]);
  let active=0,total=0;
  const loaded=await loadStateMaps(env);
  for(const m of loaded.values()){
    for(const s of m.values()){
      total++;
      if(['BUY_PENDING','OPEN','NEAR_SELL'].includes(s.status))active++;
    }
  }
  const p=parse(previewRaw,null);
  return json({
    ok:true,
    last_run:run||null,
    active_states:active,
    total_states:total,
    bootstrapped:boot==='1'&&total>0,
    min_universe:'NONE',
    coverage_policy:`No fixed stock-count threshold. Official publish requires ${(Number(env.MIN_OFFICIAL_COVERAGE_RATIO||0.50)*100).toFixed(0)}% of fetched histories on one trade date; stale/non-trading counters are carried forward unchanged.`,
    preview:p?{
      generated_at:p.generated_at,
      trade_date:p.trade_date,
      rows_received:p.rows_received,
      stocks_screened:p.stocks_screened
    }:null,
    snapshots:snaps.results||[]
  });
}

async function dashboard(env,url){
  const run=await latestRun(env,url.searchParams.get('date'));
  const reviewedAt=await setting(env,'last_reviewed_at','');
  if(!run)return json({ok:true,trade_date:'',last_run:null,counts:[],confluence:[],events:[],unread:0});
  const events=parse(run.events_json,[]);
  const counts={};
  for(const e of events)counts[e.event_type]=(counts[e.event_type]||0)+1;

  const conf=new Map();
  for(const e of events.filter(x=>x.event_type==='BUY_SIGNAL')){
    const x=conf.get(e.symbol)||{symbol:e.symbol,name:e.name||'',strategies:[],confluence:0};
    x.strategies.push(e.strategy);
    x.confluence=x.strategies.length;
    conf.set(e.symbol,x);
  }
  const confluence=[...conf.values()]
    .filter(x=>x.confluence>=2)
    .sort((a,b)=>b.confluence-a.confluence||a.symbol.localeCompare(b.symbol))
    .map(x=>({...x,strategies:x.strategies.join(',')}));

  const unread=events.filter(e=>String(e.created_at||run.generated_at)>reviewedAt).length;
  return json({
    ok:true,
    trade_date:run.trade_date,
    last_run:stripLarge(run),
    counts:Object.entries(counts).map(([event_type,n])=>({event_type,n})),
    confluence,
    events:events.slice(0,300),
    unread
  });
}

async function eventsApi(env,url){
  const rows=await env.DB.prepare(
    'SELECT trade_date,generated_at,events_json FROM daily_runs ORDER BY trade_date DESC LIMIT 365'
  ).all();
  let a=[];
  for(const r of rows.results||[])a.push(...parse(r.events_json,[]));

  const strategy=url.searchParams.get('strategy');
  const type=url.searchParams.get('type');
  const symbol=url.searchParams.get('symbol');
  if(strategy)a=a.filter(x=>x.strategy===strategy);
  if(type)a=a.filter(x=>x.event_type===type);
  if(symbol){
    const s=norm(symbol);
    a=a.filter(x=>x.symbol===s);
  }
  a.sort((x,y)=>
    String(y.trade_date).localeCompare(String(x.trade_date))||
    String(y.created_at||'').localeCompare(String(x.created_at||''))
  );
  return json({ok:true,events:a.slice(0,1000)});
}

async function positionsApi(env,url){
  const maps=await loadStateMaps(env);
  let a=[];
  for(const [strategy,m] of maps){
    for(const s of m.values()){
      if(['BUY_PENDING','OPEN','NEAR_SELL'].includes(s.status))a.push(s);
    }
  }
  const strategy=url.searchParams.get('strategy');
  const symbol=url.searchParams.get('symbol');
  if(strategy)a=a.filter(x=>x.strategy===strategy);
  if(symbol){
    const q=norm(symbol);
    a=a.filter(x=>x.symbol===q);
  }
  a.sort((x,y)=>
    (x.status==='NEAR_SELL'?0:x.status==='BUY_PENDING'?1:2)-
    (y.status==='NEAR_SELL'?0:y.status==='BUY_PENDING'?1:2)||
    x.symbol.localeCompare(y.symbol)
  );
  return json({ok:true,positions:a});
}

async function tradesApi(env,url){
  const rows=await env.DB.prepare(
    "SELECT trade_date,trades_json FROM daily_runs WHERE trades_json!='[]' ORDER BY trade_date DESC LIMIT 1000"
  ).all();
  let a=[];
  for(const r of rows.results||[])a.push(...parse(r.trades_json,[]));
  const strategy=url.searchParams.get('strategy');
  if(strategy)a=a.filter(x=>x.strategy===strategy);
  a.sort((x,y)=>String(y.exit_date).localeCompare(String(x.exit_date)));
  return json({ok:true,trades:a.slice(0,2000),performance:performance(a)});
}

function performance(trades){
  const g=new Map();
  for(const t of trades){
    const x=g.get(t.strategy)||{strategy:t.strategy,trades:0,wins:0,sum:0,gp:0,gl:0,hold:0};
    const r=Number(t.return_pct);
    x.trades++;
    x.sum+=r;
    x.hold+=Number(t.hold_days||0);
    if(r>0){x.wins++;x.gp+=r}else x.gl+=Math.abs(r);
    g.set(t.strategy,x);
  }
  return [...g.values()].map(x=>({
    strategy:x.strategy,
    trades:x.trades,
    wins:x.wins,
    win_rate:x.trades?100*x.wins/x.trades:0,
    avg_return:x.trades?x.sum/x.trades:0,
    gross_profit:x.gp,
    gross_loss:x.gl,
    profit_factor:x.gl?x.gp/x.gl:null,
    avg_hold:x.trades?x.hold/x.trades:0
  }));
}

async function previewApi(env){
  const [raw,screenerRaw]=await Promise.all([
    setting(env,'latest_preview_json',''),
    setting(env,'latest_screener_json','')
  ]);
  return json({
    ok:true,
    preview:parse(raw,null),
    screener:parse(screenerRaw,null)
  });
}

async function publishPreview(request,env){
  verifyToken(request,env);
  const p=await request.json();
  validatePayload(p,env,true);

  const old=await loadStateMaps(env);
  const events=[];
  const screener=rawScreener(p,'preview');
  const hitCounts={...screener.counts};
  const params=p.params||{};

  let advancers=0,decliners=0,unchanged=0;
  const changes=[];

  for(const row0 of p.rows){
    const row={...row0,symbol:norm(row0.symbol),trade_date:p.trade_date};

    const ch=Number(row.change_pct);
    if(Number.isFinite(ch)){
      changes.push(ch);
      if(ch>0)advancers++;
      else if(ch<0)decliners++;
      else unchanged++;
    }

    for(const strategy of STRATEGIES){
      const prev=old.get(strategy)?.get(row.symbol);
      // If the official engine already processed this same date, do not
      // manufacture a second lifecycle transition in preview.
      if(prev&&String(prev.last_trade_date||'')>=String(p.trade_date))continue;

      const out=processState(prev,row,strategy,{
        commissionPct:Number(params.commission_pct||0),
        stopLossPct:Number(params.stop_loss_pct??-7),
        atrMult:Number(params.atr_mult||3),
        nearStopPct:Number(env.NEAR_STOP_PCT||3)
      });

      for(const e0 of out.events){
        events.push({
          ...e0,
          id:crypto.randomUUID(),
          created_at:p.generated_at,
          confluence:1,
          preview:true,
          message:`PREVIEW ONLY · ${e0.message}`
        });
      }
    }
  }

  addConfluence(events);
  const eventCounts={};
  for(const e of events)eventCounts[e.event_type]=(eventCounts[e.event_type]||0)+1;

  const preview={
    ok:true,
    mode:'preview',
    generated_at:p.generated_at,
    trade_date:p.trade_date,
    stocks_screened:Number(p.stocks_screened||0),
    rows_received:p.rows.length,
    histories_on_latest_date:Number(p.histories_on_latest_date||p.rows.length),
    stale_or_nontrading:Number(p.stale_or_nontrading||0),
    bad_rows:Number(p.bad_rows||0),
    breadth:{
      advancers,
      decliners,
      unchanged,
      median_change_pct:median(changes)
    },
    hit_counts:hitCounts,
    event_counts:eventCounts,
    events:events.slice(0,300)
  };

  await env.DB.batch([
    settingStmt(env,'latest_preview_json',JSON.stringify(preview)),
    settingStmt(env,'latest_screener_json',JSON.stringify(screener))
  ]);
  return json({
    ok:true,
    trade_date:preview.trade_date,
    rows:preview.rows_received,
    events:preview.events.length
  });
}

async function manualRun(request,env){
  const runKey=request.headers.get('x-run-key')||'';
  if(!env.MANUAL_RUN_KEY||runKey!==env.MANUAL_RUN_KEY)throw http(401,'invalid manual run key');
  if(!env.GITHUB_ACTIONS_TOKEN)throw http(500,'GITHUB_ACTIONS_TOKEN is not configured');

  const lastRaw=await setting(env,'manual_run_last_at','');
  const lastMs=Date.parse(lastRaw||'');
  if(Number.isFinite(lastMs)&&Date.now()-lastMs<60000){
    throw http(429,'A manual preview was triggered less than 60 seconds ago.');
  }

  const apiUrl=`https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`;
  const r=await fetch(apiUrl,{
    method:'POST',
    headers:githubHeaders(env),
    body:JSON.stringify({ref:'main'})
  });

  const text=await r.text();
  let body=null;
  if(text){
    try{body=JSON.parse(text)}catch{body={message:text.slice(0,300)}}
  }
  if(!r.ok)throw http(r.status,body?.message||`GitHub preview dispatch failed (${r.status})`);

  const triggeredAt=new Date().toISOString();
  await upsertSetting(env,'manual_run_last_at',triggeredAt);
  return json({
    ok:true,
    mode:'preview',
    triggered_at:triggeredAt,
    message:'Manual preview started through the same strategy-scan workflow. It will not alter official strategy history.'
  });
}

async function markReviewed(env){
  await upsertSetting(env,'last_reviewed_at',new Date().toISOString());
  return json({ok:true});
}

async function bootstrapSnapshot(request,env,url){
  verifyToken(request,env);
  const p=await request.json();
  if(!p||!Array.isArray(p.states)||!p.states.length)throw http(400,'non-empty states array required');

  const current=await setting(env,'bootstrapped','0');
  if(current==='1'&&url.searchParams.get('replace')!=='1'){
    throw http(409,'already bootstrapped; use ?replace=1 to intentionally replace');
  }

  const grouped=new Map(STRATEGIES.map(s=>[s,new Map()]));
  for(const s0 of p.states){
    const s={...s0,symbol:norm(s0.symbol)};
    if(!grouped.has(s.strategy)||!s.symbol)throw http(422,'invalid bootstrap strategy/symbol');
    const m=grouped.get(s.strategy);
    if(m.has(s.symbol))throw http(422,`duplicate bootstrap ${s.strategy}|${s.symbol}`);
    m.set(s.symbol,s);
  }
  for(const strategy of STRATEGIES){
    if(grouped.get(strategy).size<1)throw http(422,`bootstrap ${strategy} has no states`);
  }

  const bootEvents=(p.events||[]).map(e=>({
    ...e,
    id:e.id||crypto.randomUUID(),
    created_at:p.generated_at,
    confluence:Number(e.confluence||1)
  }));
  addConfluence(bootEvents);
  const bootTrades=Array.isArray(p.trades)?p.trades:[];

  const stmts=STRATEGIES.map(strategy=>snapshotStmt(env,strategy,p.trade_date,grouped.get(strategy)));
  stmts.push(settingStmt(env,'bootstrapped','1'));
  stmts.push(
    env.DB.prepare(
      `INSERT OR REPLACE INTO daily_runs(
        trade_date,id,generated_at,stocks_screened,rows_received,status,message,
        payload_hash,events_json,trades_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      p.trade_date,
      crypto.randomUUID(),
      p.generated_at||new Date().toISOString(),
      Number(p.stocks_screened||0),
      p.states.length,
      'OK',
      `Historical state bootstrap complete: ${p.states.length} strategy states`,
      await hash(JSON.stringify(['bootstrap',p.trade_date,p.states.length])),
      JSON.stringify(bootEvents),
      JSON.stringify(bootTrades)
    )
  );

  await env.DB.batch(stmts);
  const verify=await loadStateMaps(env);
  for(const strategy of STRATEGIES){
    if(verify.get(strategy)?.size!==grouped.get(strategy).size){
      throw http(500,`bootstrap verify failed for ${strategy}`);
    }
  }
  return json({
    ok:true,
    states:p.states.length,
    events:bootEvents.length,
    trades:bootTrades.length,
    trade_date:p.trade_date
  });
}

async function publishSnapshot(request,env){
  verifyToken(request,env);
  const p=await request.json();
  validatePayload(p,env,false);

  if(await setting(env,'bootstrapped','0')!=='1'){
    throw http(409,'historical bootstrap required before daily publish');
  }

  const old=await loadStateMaps(env);
  const next=new Map(STRATEGIES.map(s=>[s,new Map(old.get(s)||[])]));
  const events=[];
  const trades=[];
  const params=p.params||{};

  // Only symbols with a valid bar for this trade date are processed.
  // Illiquid/non-trading symbols are absent from p.rows and therefore their
  // prior state is carried forward unchanged.
  for(const row0 of p.rows){
    const row={...row0,symbol:norm(row0.symbol),trade_date:p.trade_date};

    for(const strategy of STRATEGIES){
      const m=next.get(strategy);
      const out=processState(m.get(row.symbol),row,strategy,{
        commissionPct:Number(params.commission_pct||0),
        stopLossPct:Number(params.stop_loss_pct??-7),
        atrMult:Number(params.atr_mult||3),
        nearStopPct:Number(env.NEAR_STOP_PCT||3)
      });

      m.set(row.symbol,out.state);

      for(const e0 of out.events){
        const e={
          ...e0,
          id:crypto.randomUUID(),
          created_at:p.generated_at,
          confluence:1
        };
        events.push(e);

        if(e.event_type==='SELL'){
          trades.push({
            strategy,
            symbol:row.symbol,
            name:row.name||'',
            cycle:out.state.cycle,
            signal_date:out.state.signal_date,
            entry_date:out.state.entry_date,
            entry_price:out.state.entry_price,
            exit_date:out.state.closed_date,
            exit_price:out.state.exit_price,
            return_pct:out.state.return_pct,
            hold_days:out.state.hold_days,
            exit_reason:'trail_stop'
          });
        }
      }
    }
  }

  addConfluence(events);

  const h=await hash(JSON.stringify([
    p.trade_date,p.generated_at,p.stocks_screened,p.rows.length
  ]));
  const same=await env.DB.prepare(
    'SELECT payload_hash FROM daily_runs WHERE trade_date=?'
  ).bind(p.trade_date).first();

  if(same?.payload_hash===h){
    return json({ok:true,duplicate:true,trade_date:p.trade_date});
  }
  if(same){
    throw http(
      409,
      `trade date ${p.trade_date} was already published with a different payload; refusing overwrite`
    );
  }

  const writes=STRATEGIES.map(s=>snapshotStmt(env,s,p.trade_date,next.get(s)));
  writes.push(
    env.DB.prepare(
      `INSERT INTO daily_runs(
        trade_date,id,generated_at,stocks_screened,rows_received,status,message,
        payload_hash,events_json,trades_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      p.trade_date,
      crypto.randomUUID(),
      p.generated_at,
      p.stocks_screened,
      p.rows.length,
      'OK',
      `Processed ${p.rows.length}/${p.stocks_screened} valid current-date Bursa rows; stale/non-trading counters carried forward`,
      h,
      JSON.stringify(events),
      JSON.stringify(trades)
    )
  );
  writes.push(settingStmt(env,'latest_screener_json',JSON.stringify(rawScreener(p,'official'))));

  await env.DB.batch(writes);
  return json({
    ok:true,
    trade_date:p.trade_date,
    stocks:p.rows.length,
    stocks_screened:p.stocks_screened,
    events:events.length,
    trades:trades.length
  });
}

function rawScreener(p,source){
  const src=p.raw_screener||{};
  const hits={};
  const counts={};
  for(const st of STRATEGIES){
    hits[st]=(Array.isArray(src.hits?.[st])?src.hits[st]:[]).map(x=>({
      symbol:String(x.symbol||''),
      name:String(x.name||''),
      close:finite(x.close)?Number(x.close):null,
      rsi:finite(x.rsi)?Number(x.rsi):null,
      adx:finite(x.adx)?Number(x.adx):null,
      vol_ratio:finite(x.vol_ratio)?Number(x.vol_ratio):null,
      roc10:finite(x.roc10)?Number(x.roc10):null
    }));
    counts[st]=hits[st].length;
  }
  return {
    generated_at:p.generated_at,
    trade_date:p.trade_date,
    stocks_screened:Number(p.stocks_screened||0),
    source,
    counts,
    hits
  };
}

function addConfluence(events){
  const by=new Map();
  for(const e of events.filter(x=>x.event_type==='BUY_SIGNAL')){
    const a=by.get(e.symbol)||[];
    a.push(e);
    by.set(e.symbol,a);
  }
  for(const a of by.values()){
    if(a.length>=2)for(const e of a)e.confluence=a.length;
  }
}

function validatePayload(p,env,preview=false){
  if(!p||!Array.isArray(p.rows))throw http(400,'rows array required');
  if(!p.rows.length)throw http(422,'at least one valid current-date row is required');
  if(!Number.isFinite(Number(p.stocks_screened))||Number(p.stocks_screened)<=0){
    throw http(422,'positive stocks_screened required');
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(p.trade_date||''))){
    throw http(400,'valid trade_date required');
  }
  if(!p.generated_at||Number.isNaN(new Date(p.generated_at).getTime())){
    throw http(400,'valid generated_at required');
  }
  if(!p.raw_screener||!p.raw_screener.hits||
     STRATEGIES.some(st=>!Array.isArray(p.raw_screener.hits[st]))){
    throw http(422,'raw_screener hits required for Trending/Momentum/M.E.T.A.');
  }

  if(!preview){
    const ratio=Math.max(0.05,Math.min(1,Number(env.MIN_OFFICIAL_COVERAGE_RATIO||0.50)));
    const required=Math.max(1,Math.ceil(Number(p.stocks_screened)*ratio));
    if(p.rows.length<required){
      throw http(
        422,
        `Official coverage guard: ${p.rows.length}/${p.stocks_screened} valid current-date rows; need >=${required} (${(ratio*100).toFixed(0)}%)`
      );
    }
  }

  const seen=new Set();
  for(const r of p.rows){
    if(!r.symbol||![r.open,r.low,r.close,r.atr].every(x=>finite(x)&&Number(x)>0)){
      throw http(422,'positive symbol/open/low/close/atr required');
    }
    const sym=norm(r.symbol);
    if(seen.has(sym))throw http(422,`duplicate symbol ${sym}`);
    seen.add(sym);
    if(!r.hits||STRATEGIES.some(st=>typeof r.hits[st]!=='boolean')){
      throw http(422,`invalid hits for ${sym}`);
    }
  }
}

async function loadStateMaps(env){
  const r=await env.DB.prepare('SELECT strategy,state_json FROM strategy_snapshots').all();
  const out=new Map(STRATEGIES.map(s=>[s,new Map()]));
  for(const x of r.results||[]){
    if(!out.has(x.strategy))continue;
    const obj=parse(x.state_json,{});
    out.set(x.strategy,new Map(Object.entries(obj)));
  }
  return out;
}

function snapshotStmt(env,strategy,tradeDate,map){
  const obj=Object.fromEntries(map);
  return env.DB.prepare(
    `INSERT INTO strategy_snapshots(strategy,trade_date,state_json,updated_at)
     VALUES(?,?,?,datetime('now'))
     ON CONFLICT(strategy) DO UPDATE SET
       trade_date=excluded.trade_date,
       state_json=excluded.state_json,
       updated_at=datetime('now')`
  ).bind(strategy,tradeDate,JSON.stringify(obj));
}

async function latestRun(env,date){
  if(date){
    return env.DB.prepare('SELECT * FROM daily_runs WHERE trade_date=?').bind(date).first();
  }
  return env.DB.prepare('SELECT * FROM daily_runs ORDER BY trade_date DESC LIMIT 1').first();
}

function stripLarge(r){
  if(!r)return r;
  const {events_json,trades_json,...x}=r;
  return x;
}

async function setting(env,key,fallback=''){
  const r=await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first();
  return r?.value??fallback;
}

function settingStmt(env,key,value){
  return env.DB.prepare(
    `INSERT INTO app_settings(key,value,updated_at)
     VALUES(?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       updated_at=datetime('now')`
  ).bind(key,String(value));
}

async function upsertSetting(env,key,value){
  await settingStmt(env,key,value).run();
}

function verifyToken(request,env){
  const auth=request.headers.get('authorization')||'';
  const x=request.headers.get('x-publish-token')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):x;
  if(!env.PUBLISH_TOKEN||token!==env.PUBLISH_TOKEN)throw http(401,'invalid publish token');
}

function githubHeaders(env){
  if(!env.GITHUB_ACTIONS_TOKEN)throw http(500,'GITHUB_ACTIONS_TOKEN is not configured');
  return {
    'Accept':'application/vnd.github+json',
    'Authorization':'Bearer '+env.GITHUB_ACTIONS_TOKEN,
    'X-GitHub-Api-Version':'2026-03-10',
    'User-Agent':'BursaMusangKing-StrategyTerminal',
    'content-type':'application/json'
  };
}

function median(values){
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return null;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}


function norm(s){
  let v=String(s||'').toUpperCase().replace(/^MYX:/,'');
  if(v.endsWith('.KL'))return v;
  if(/^\d{1,4}$/.test(v))return v.padStart(4,'0')+'.KL';
  return v;
}

function finite(v){
  return Number.isFinite(Number(v));
}

function parse(s,f){
  try{return JSON.parse(s)}catch{return f}
}

function json(v,status=200){
  return new Response(JSON.stringify(v),{status,headers:JSON_HEADERS});
}

function http(status,message){
  const e=new Error(message);
  e.status=status;
  return e;
}

async function hash(s){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  return [...new Uint8Array(b)]
    .map(x=>x.toString(16).padStart(2,'0'))
    .join('');
}
