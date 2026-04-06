import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import * as mammoth from "mammoth";
import JSZip from "jszip";

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const WORKER_URL = "https://visual.ttimes.workers.dev";
const C = {
  bg:"#0f1117", sf:"#1a1d27", bd:"#2a2d3a", tx:"#e4e4e7",
  txM:"#a1a1aa", txD:"#71717a", ac:"#4A6CF7", acS:"rgba(74,108,247,0.12)",
  ok:"#22C55E", wn:"#F59E0B", err:"#EF4444",
};
const FN = "'Pretendard','Noto Sans KR',-apple-system,sans-serif";
const VIS_COLORS = ["#3B82F6","#8B5CF6","#EF4444","#22C55E","#F59E0B","#EC4899","#06B6D4","#F97316"];
const AUTOSAVE_INTERVAL = 3 * 60 * 1000;
const VIS_CATEGORIES = [
  {value:"",label:"🎯 AI 자동 선택"},{value:"bar",label:"📊 막대 차트"},{value:"bar_horizontal",label:"📊 수평 막대"},
  {value:"line",label:"📈 라인"},{value:"donut",label:"🍩 도넛"},{value:"kpi",label:"🔢 KPI"},
  {value:"table",label:"📋 표"},{value:"comparison",label:"⚖️ 비교"},{value:"ranking",label:"🏆 랭킹"},
  {value:"process",label:"🔄 프로세스"},{value:"timeline",label:"📅 타임라인"},{value:"structure",label:"🧱 구조도"},
  {value:"cycle",label:"♻️ 순환"},{value:"matrix",label:"📐 매트릭스"},{value:"hierarchy",label:"🌳 계층도"},
  {value:"radar",label:"🕸 레이더"},{value:"venn",label:"⭕ 벤"},{value:"network",label:"🔗 네트워크"},
  {value:"stack",label:"📚 스택"},{value:"progress",label:"📏 진행률"},{value:"checklist",label:"☑️ 체크리스트"},
];

// ═══════════════════════════════════════
// API
// ═══════════════════════════════════════
async function apiCall(endpoint, body) {
  const r = await fetch(`${WORKER_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
// DOCX 삭제선 파싱
// ═══════════════════════════════════════
async function parseDocxWithTrackChanges(ab) {
  const zip = await JSZip.loadAsync(ab);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("word/document.xml 없음");
  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error("본문 없음");
  const paragraphs = [];
  const pRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(bodyMatch[1])) !== null) {
    const segs = [];
    const tRe = /<w:del\b[^>]*>([\s\S]*?)<\/w:del>|<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>|<w:r[ >]([\s\S]*?)<\/w:r>/g;
    let tm;
    while ((tm = tRe.exec(pm[0])) !== null) {
      if (tm[1]!==undefined) { const dt=(tm[1].match(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g)||[]).map(d=>d.replace(/<[^>]+>/g,"")).join(""); if(dt) segs.push({text:dt,deleted:true}); }
      else if (tm[2]!==undefined) { const t=(tm[2].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)||[]).map(d=>d.replace(/<[^>]+>/g,"")).join(""); if(t) segs.push({text:t,deleted:false}); }
      else if (tm[3]!==undefined) { const t=(tm[3].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)||[]).map(d=>d.replace(/<[^>]+>/g,"")).join(""); if(t) segs.push({text:t,deleted:false}); }
    }
    if (segs.length > 0) paragraphs.push(segs);
  }
  return {
    hasTrackChanges: paragraphs.some(p=>p.some(s=>s.deleted)),
    fullText: paragraphs.map(p=>p.map(s=>s.text).join("")).join("\n"),
    cleanText: paragraphs.map(p=>p.filter(s=>!s.deleted).map(s=>s.text).join("")).join("\n"),
    paragraphs
  };
}

// ═══════════════════════════════════════
// FILE UPLOADER
// ═══════════════════════════════════════
function FileUploader({onFileLoad,busy}) {
  const [dragging,setDragging] = useState(false);
  const inputRef = useRef(null);
  return <div onDragOver={e=>{e.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)}
    onDrop={e=>{e.preventDefault();setDragging(false);onFileLoad(e.dataTransfer.files[0])}}
    onClick={()=>inputRef.current?.click()}
    style={{border:`2px dashed ${dragging?C.ac:C.bd}`,borderRadius:16,padding:"32px",textAlign:"center",
      cursor:busy?"not-allowed":"pointer",background:dragging?C.acS:"transparent",transition:"all 0.2s"}}>
    <input ref={inputRef} type="file" accept=".docx,.txt" style={{display:"none"}} onChange={e=>onFileLoad(e.target.files[0])}/>
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={C.ac} strokeWidth="1.5" style={{marginBottom:12}}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
    <div style={{fontSize:15,fontWeight:600,color:C.tx,marginBottom:6}}>.docx 또는 .txt 파일을 드래그하거나 클릭하여 업로드</div>
    <div style={{fontSize:12,color:C.txD}}>Word 검토 모드의 삭제선(취소선)을 자동 인식합니다</div>
  </div>;
}

// ═══════════════════════════════════════
// BLOCK PARSER (ttimes-doctor 호환)
// ═══════════════════════════════════════
function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let cur = null;
  const speakerRe = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  const inlineRe = /^(.{1,20}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)/;
  for (const line of lines) {
    const m = line.match(speakerRe);
    if (m) {
      if (cur && cur.text.trim()) blocks.push(cur);
      cur = { index: blocks.length, speaker: m[1].trim(), timestamp: m[2], text: "" };
    } else {
      const im = line.trim().match(inlineRe);
      if (im && !/\d{1,2}:\d{2}/.test(im[1])) {
        if (cur && cur.text.trim()) blocks.push(cur);
        cur = { index: blocks.length, speaker: im[1].trim(), timestamp: im[2], text: (im[3]||"").trim() };
      } else {
        if (!cur) cur = { index: 0, speaker: "—", timestamp: "0:00", text: "" };
        cur.text += (cur.text ? "\n" : "") + line;
      }
    }
  }
  if (cur && cur.text.trim()) blocks.push(cur);
  let result = blocks.map((b, i) => ({ ...b, index: i }));

  // fallback: 블록이 1개뿐이면 빈 줄 기준으로 문단 분할
  if (result.length <= 1 && text.trim().length > 200) {
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    if (paragraphs.length > 1) {
      result = paragraphs.map((p, i) => ({ index: i, speaker: "—", timestamp: "", text: p }));
    }
  }
  return result;
}

// ═══════════════════════════════════════
// VISUAL MOCKUP (21종)
// ═══════════════════════════════════════
function VisualMockup({ type, chart_data, title }) {
  if (!chart_data) return <div style={{padding:12,fontSize:12,color:C.txD}}>데이터 없음</div>;
  const wrap = (ch) => (
    <div style={{background:"rgba(0,0,0,0.3)",borderRadius:10,padding:14,marginTop:8}}>
      {title && <div style={{fontSize:12,fontWeight:700,color:C.tx,marginBottom:10,textAlign:"center"}}>{title}</div>}
      {ch}
    </div>
  );

  // BAR / BAR_HORIZONTAL / BAR_STACKED
  if (["bar","bar_horizontal","bar_stacked"].includes(type)) {
    const d = chart_data, labels = d.labels||[], datasets = d.datasets||[];
    const maxVal = Math.max(...datasets.flatMap(ds=>ds.data||[]),1);
    const isH = type==="bar_horizontal";
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:6}}>
      {isH ? labels.map((lb,i) => <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:11,color:C.txM,width:80,textAlign:"right",flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lb}</span>
        <div style={{flex:1,display:"flex",gap:2}}>
          {datasets.map((ds,vi) => <div key={vi} style={{height:20,borderRadius:3,background:(ds.colors||VIS_COLORS)[i%VIS_COLORS.length],
            width:`${((ds.data||[])[i]||0)/maxVal*100}%`,minWidth:2}}/>)}
        </div>
        <span style={{fontSize:10,color:C.txD,width:40}}>{datasets.map(ds=>(ds.data||[])[i]||0).join("/")}{d.unit||""}</span>
      </div>) : <div style={{display:"flex",alignItems:"flex-end",gap:4,height:120,padding:"0 4px"}}>
        {labels.map((lb,i) => <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
          <div style={{width:"100%",display:"flex",flexDirection:"column-reverse",height:100}}>
            {datasets.map((ds,di) => {const v=(ds.data||[])[i]||0; return <div key={di} style={{width:"80%",margin:"0 auto",
              height:`${(v/maxVal)*100}%`,background:(ds.colors||VIS_COLORS)[type==="bar_stacked"?di:i%VIS_COLORS.length],
              borderRadius:type==="bar_stacked"?0:3,minHeight:v>0?2:0}}/>;
            })}
          </div>
          <span style={{fontSize:9,color:C.txD,textAlign:"center",lineHeight:1.2}}>{lb}</span>
        </div>)}
      </div>}
      {datasets.length>1 && <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:4}}>
        {datasets.map((ds,di) => <span key={di} style={{fontSize:10,color:C.txM,display:"flex",alignItems:"center",gap:3}}>
          <span style={{width:8,height:8,borderRadius:2,background:VIS_COLORS[di%VIS_COLORS.length]}}/>{ds.label}
        </span>)}
      </div>}
    </div>);
  }

  // LINE / AREA
  if (["line","area"].includes(type)) {
    const d=chart_data, labels=d.labels||[], datasets=d.datasets||[];
    const all=datasets.flatMap(ds=>ds.data||[]), mn=Math.min(...all), mx=Math.max(...all), range=mx-mn||1;
    return wrap(<div>
      <svg viewBox={`0 0 200 100`} style={{width:"100%",height:100}}>
        {datasets.map((ds,di) => {
          const pts=(ds.data||[]).map((v,i)=>`${i*(200/Math.max(labels.length-1,1))},${90-((v-mn)/range)*80}`);
          const c=(ds.colors||VIS_COLORS)[di%VIS_COLORS.length];
          return <g key={di}>
            {type==="area"&&<polygon points={`0,90 ${pts.join(" ")} ${(ds.data.length-1)*(200/Math.max(labels.length-1,1))},90`} fill={c} fillOpacity={0.15}/>}
            <polyline points={pts.join(" ")} fill="none" stroke={c} strokeWidth={2}/>
            {(ds.data||[]).map((v,i)=><circle key={i} cx={i*(200/Math.max(labels.length-1,1))} cy={90-((v-mn)/range)*80} r={3} fill={c}/>)}
          </g>;
        })}
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",padding:"0 4px"}}>
        {labels.map((lb,i)=><span key={i} style={{fontSize:9,color:C.txD}}>{lb}</span>)}
      </div>
    </div>);
  }

  // DONUT
  if (type==="donut") {
    const ds=(chart_data.datasets||[])[0]||{}, data=ds.data||[], colors=ds.colors||VIS_COLORS;
    const total=data.reduce((s,v)=>s+v,0)||1; let acc=0;
    return wrap(<div style={{display:"flex",alignItems:"center",gap:16}}>
      <svg viewBox="0 0 100 100" style={{width:90,height:90}}>
        {data.map((v,i) => {const pct=v/total,start=acc; acc+=pct;
          const x1=50+40*Math.cos(2*Math.PI*start-Math.PI/2),y1=50+40*Math.sin(2*Math.PI*start-Math.PI/2);
          const x2=50+40*Math.cos(2*Math.PI*(start+pct)-Math.PI/2),y2=50+40*Math.sin(2*Math.PI*(start+pct)-Math.PI/2);
          return <path key={i} d={`M50,50 L${x1},${y1} A40,40 0 ${pct>0.5?1:0},1 ${x2},${y2} Z`} fill={colors[i%colors.length]} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5}/>;
        })}
        <circle cx={50} cy={50} r={22} fill={C.sf}/>
      </svg>
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        {(chart_data.labels||[]).map((lb,i)=><span key={i} style={{fontSize:11,color:C.txM,display:"flex",alignItems:"center",gap:4}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:colors[i%colors.length]}}/>{lb} ({data[i]}{chart_data.unit||""})
        </span>)}
      </div>
    </div>);
  }

  // COMPARISON
  if (type==="comparison") {
    const cols=chart_data.columns||[];
    return wrap(<div>
      <div style={{display:"grid",gridTemplateColumns:`repeat(${cols.length},1fr)`,gap:8}}>
        {cols.map((col,ci) => {
          const tone=col.tone, hdrBg=tone==="positive"?"rgba(34,197,94,0.15)":tone==="negative"?"rgba(239,68,68,0.15)":"rgba(59,130,246,0.15)";
          const hdrColor=tone==="positive"?"#22C55E":tone==="negative"?"#EF4444":"#3B82F6";
          return <div key={ci}>
            <div style={{padding:"6px 10px",borderRadius:6,background:hdrBg,marginBottom:6,textAlign:"center",fontSize:12,fontWeight:700,color:hdrColor}}>{col.label}</div>
            {(col.items||[]).map((item,ii)=><div key={ii} style={{padding:"4px 8px",fontSize:11,color:C.txM,borderLeft:`2px solid ${hdrColor}`,marginBottom:4,paddingLeft:8}}>{item}</div>)}
          </div>;
        })}
      </div>
      {chart_data.footer && <div style={{marginTop:8,fontSize:11,color:C.txD,textAlign:"center",fontStyle:"italic"}}>{chart_data.footer}</div>}
    </div>);
  }

  // TABLE
  if (type==="table") {
    const h=chart_data.headers||[], rows=chart_data.rows||[], hlR=new Set(chart_data.highlight_rows||[]);
    return wrap(<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
      <thead><tr>{h.map((hd,i)=><th key={i} style={{padding:"6px 8px",textAlign:"left",borderBottom:`2px solid ${C.ac}`,color:C.ac,fontWeight:700}}>{hd}</th>)}</tr></thead>
      <tbody>{rows.map((row,ri)=><tr key={ri} style={{background:hlR.has(ri)?"rgba(59,130,246,0.1)":"transparent"}}>
        {row.map((cell,ci)=><td key={ci} style={{padding:"5px 8px",borderBottom:`1px solid ${C.bd}`,color:C.txM,fontWeight:hlR.has(ri)?600:400}}>{cell}</td>)}
      </tr>)}</tbody>
    </table></div>);
  }

  // PROCESS
  if (type==="process") {
    const steps=chart_data.steps||[];
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {steps.map((step,i)=><div key={i}>
        <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
          <div style={{width:28,height:28,borderRadius:"50%",background:C.ac,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{i+1}</div>
          <div style={{flex:1,paddingTop:3}}><div style={{fontSize:12,fontWeight:600,color:C.tx}}>{step.label}</div>
            {step.description&&<div style={{fontSize:10,color:C.txD,marginTop:1}}>{step.description}</div>}</div>
        </div>
        {i<steps.length-1&&<div style={{width:2,height:16,background:C.bd,marginLeft:13}}/>}
      </div>)}
    </div>);
  }

  // STRUCTURE
  if (type==="structure") {
    const items=chart_data.items||[];
    const cm={purple:"#8B5CF6",blue:"#3B82F6",green:"#22C55E",red:"#EF4444",yellow:"#F59E0B",cyan:"#06B6D4",pink:"#EC4899",orange:"#F97316"};
    return wrap(<div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
      {items.map((it,i) => {const c=cm[it.color]||VIS_COLORS[i%VIS_COLORS.length];
        return <div key={i} style={{padding:"10px 12px",borderRadius:8,border:`1px solid ${c}33`,background:`${c}11`}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
            <span style={{fontSize:14,fontWeight:800,color:c}}>{it.num||i+1}</span>
            <span style={{fontSize:12,fontWeight:600,color:C.tx}}>{it.label}</span></div>
          {it.description&&<div style={{fontSize:10,color:C.txM}}>{it.description}</div>}
        </div>;
      })}
    </div>);
  }

  // TIMELINE
  if (["timeline","timeline_horizontal"].includes(type)) {
    const events=chart_data.events||[];
    if (type==="timeline_horizontal") return wrap(<div style={{overflowX:"auto"}}><div style={{display:"flex",gap:4,minWidth:events.length*120}}>
      {events.map((ev,i)=><div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",minWidth:100}}>
        <div style={{width:12,height:12,borderRadius:"50%",background:VIS_COLORS[i%VIS_COLORS.length],marginBottom:4}}/>
        <div style={{width:2,height:20,background:C.bd}}/>
        <div style={{textAlign:"center",padding:"6px 4px"}}>
          <div style={{fontSize:10,fontWeight:700,color:VIS_COLORS[i%VIS_COLORS.length]}}>{ev.period}</div>
          <div style={{fontSize:11,fontWeight:600,color:C.tx,marginTop:2}}>{ev.label}</div>
          {ev.description&&<div style={{fontSize:9,color:C.txD,marginTop:1}}>{ev.description}</div>}
        </div>
      </div>)}
    </div></div>);
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {events.map((ev,i)=><div key={i} style={{display:"flex",gap:10}}>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:16}}>
          <div style={{width:10,height:10,borderRadius:"50%",background:VIS_COLORS[i%VIS_COLORS.length],flexShrink:0}}/>
          {i<events.length-1&&<div style={{width:2,flex:1,background:C.bd}}/>}
        </div>
        <div style={{flex:1,paddingBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:VIS_COLORS[i%VIS_COLORS.length]}}>{ev.period}</div>
          <div style={{fontSize:12,fontWeight:600,color:C.tx}}>{ev.label}</div>
          {ev.description&&<div style={{fontSize:10,color:C.txD,marginTop:1}}>{ev.description}</div>}
        </div>
      </div>)}
    </div>);
  }

  // KPI
  if (type==="kpi") {
    const metrics=chart_data.metrics||[];
    const ti={up:"↑",down:"↓",neutral:"→"}, tc={up:"#22C55E",down:"#EF4444",neutral:"#94A3B8"};
    return wrap(<div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(metrics.length,4)},1fr)`,gap:10}}>
      {metrics.map((m,i)=><div key={i} style={{textAlign:"center",padding:"10px 8px",borderRadius:8,background:"rgba(255,255,255,0.04)",border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:22,fontWeight:800,color:C.ac}}>{m.value}</div>
        <div style={{fontSize:10,color:C.txD,marginTop:2}}>{m.label}</div>
        {m.trend&&<span style={{fontSize:12,color:tc[m.trend]||C.txD}}>{ti[m.trend]||""}</span>}
      </div>)}
    </div>);
  }

  // RANKING
  if (type==="ranking") {
    const items=chart_data.items||[];
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:6}}>
      {items.map((it,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",borderRadius:8,
        background:i===0?"rgba(245,158,11,0.1)":"rgba(255,255,255,0.03)"}}>
        <span style={{fontSize:16,fontWeight:800,color:i===0?"#F59E0B":i===1?"#94A3B8":"#CD7F32",width:24}}>{it.rank||i+1}</span>
        <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:C.tx}}>{it.label}</div>
          {it.description&&<div style={{fontSize:10,color:C.txD}}>{it.description}</div>}</div>
        {it.value&&<span style={{fontSize:12,fontWeight:700,color:C.ac}}>{it.value}</span>}
      </div>)}
    </div>);
  }

  // MATRIX
  if (type==="matrix") {
    const quads=chart_data.quadrants||[];
    const pm={"top-left":[0,0],"top-right":[0,1],"bottom-left":[1,0],"bottom-right":[1,1]};
    const grid=[[null,null],[null,null]]; quads.forEach(q=>{const p=pm[q.position];if(p)grid[p[0]][p[1]]=q;});
    return wrap(<div>
      <div style={{textAlign:"center",fontSize:10,color:C.txD,marginBottom:4}}>↑ {chart_data.y_axis||""}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
        {grid.flat().map((q,i)=><div key={i} style={{padding:"10px 8px",borderRadius:6,background:q?`${VIS_COLORS[i]}15`:"rgba(255,255,255,0.02)",border:`1px solid ${q?VIS_COLORS[i]+"33":C.bd}`,minHeight:60}}>
          {q&&<><div style={{fontSize:11,fontWeight:700,color:VIS_COLORS[i]}}>{q.label}</div>
            {(q.items||[]).map((it,ii)=><div key={ii} style={{fontSize:10,color:C.txM,marginTop:2}}>· {it}</div>)}</>}
        </div>)}
      </div>
      <div style={{textAlign:"center",fontSize:10,color:C.txD,marginTop:4}}>{chart_data.x_axis||""} →</div>
    </div>);
  }

  // STACK
  if (type==="stack") {
    const layers=chart_data.layers||[];
    const cm={purple:"#8B5CF6",blue:"#3B82F6",green:"#22C55E",red:"#EF4444",yellow:"#F59E0B",cyan:"#06B6D4"};
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {layers.map((l,i) => {const c=cm[l.color]||VIS_COLORS[i%VIS_COLORS.length];
        return <div key={i} style={{padding:"8px 12px",borderRadius:6,background:`${c}15`,borderLeft:`3px solid ${c}`}}>
          <div style={{fontSize:12,fontWeight:600,color:c}}>{l.label}</div>
          {l.description&&<div style={{fontSize:10,color:C.txM}}>{l.description}</div>}
        </div>;
      })}
    </div>);
  }

  // CYCLE
  if (type==="cycle") {
    const steps=chart_data.steps||[];
    return wrap(<div style={{display:"flex",flexDirection:"column",gap:2}}>
      {steps.map((s,i)=><div key={i}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:24,height:24,borderRadius:"50%",background:VIS_COLORS[i%VIS_COLORS.length],color:"#fff",
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{i+1}</div>
          <div style={{flex:1}}><span style={{fontSize:12,fontWeight:600,color:C.tx}}>{s.label}</span>
            {s.description&&<span style={{fontSize:10,color:C.txD,marginLeft:6}}>{s.description}</span>}</div>
        </div>
        <div style={{marginLeft:11,fontSize:14,color:C.txD}}>{i<steps.length-1?"↓":"↩"}</div>
      </div>)}
    </div>);
  }

  // CHECKLIST
  if (type==="checklist") {
    const h=chart_data.headers||[], rows=chart_data.rows||[];
    return wrap(<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
      <thead><tr>{h.map((hd,i)=><th key={i} style={{padding:"5px 8px",textAlign:i===0?"left":"center",borderBottom:`2px solid ${C.bd}`,color:C.txM,fontWeight:700}}>{hd}</th>)}</tr></thead>
      <tbody>{rows.map((row,ri)=><tr key={ri}>{row.map((cell,ci)=><td key={ci} style={{padding:"4px 8px",borderBottom:`1px solid ${C.bd}`,
        textAlign:ci===0?"left":"center",color:cell==="O"?"#22C55E":cell==="X"?"#EF4444":C.txM,fontWeight:ci===0?400:700}}>{cell}</td>)}</tr>)}</tbody>
    </table></div>);
  }

  // HIERARCHY
  if (type==="hierarchy") {
    const root=chart_data.root; if(!root) return wrap(<div style={{fontSize:11,color:C.txD}}>데이터 없음</div>);
    const renderN=(n,d=0)=>(<div key={n.label} style={{marginLeft:d*16}}>
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 0"}}>
        {d>0&&<span style={{color:C.txD}}>└</span>}
        <span style={{fontSize:11,fontWeight:d===0?700:400,color:d===0?C.ac:C.txM,padding:"2px 8px",borderRadius:4,background:d===0?`${C.ac}15`:"transparent"}}>{n.label}</span>
      </div>
      {(n.children||[]).map(ch=>renderN(ch,d+1))}
    </div>);
    return wrap(renderN(root));
  }

  // RADAR
  if (type==="radar") {
    const labels=chart_data.labels||[], datasets=chart_data.datasets||[], n=labels.length;
    if(n<3) return wrap(<div style={{fontSize:11,color:C.txD}}>축 3개 이상 필요</div>);
    const cx=80,cy=80,r=60;
    return wrap(<svg viewBox="0 0 160 170" style={{width:"100%",maxWidth:200,margin:"0 auto",display:"block"}}>
      {[0.25,0.5,0.75,1].map(s=><polygon key={s} points={labels.map((_,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;return `${cx+r*s*Math.cos(a)},${cy+r*s*Math.sin(a)}`;}).join(" ")} fill="none" stroke={C.bd} strokeWidth={0.5}/>)}
      {datasets.map((ds,di) => {const mV=Math.max(...ds.data||[],1);
        const pts=(ds.data||[]).map((v,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;return `${cx+r*(v/mV)*Math.cos(a)},${cy+r*(v/mV)*Math.sin(a)}`;}).join(" ");
        const c=VIS_COLORS[di%VIS_COLORS.length];
        return <polygon key={di} points={pts} fill={c} fillOpacity={0.2} stroke={c} strokeWidth={1.5}/>;
      })}
      {labels.map((lb,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;return <text key={i} x={cx+(r+14)*Math.cos(a)} y={cy+(r+14)*Math.sin(a)} textAnchor="middle" dominantBaseline="middle" style={{fontSize:8,fill:C.txM}}>{lb}</text>;})}
    </svg>);
  }

  // VENN
  if (type==="venn") {
    const sets=chart_data.sets||[], inter=chart_data.intersection;
    return wrap(<div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
      <svg viewBox="0 0 200 120" style={{width:"100%",maxWidth:240}}>
        <circle cx={75} cy={60} r={45} fill={VIS_COLORS[0]} fillOpacity={0.2} stroke={VIS_COLORS[0]} strokeWidth={1.5}/>
        <circle cx={125} cy={60} r={45} fill={VIS_COLORS[1]} fillOpacity={0.2} stroke={VIS_COLORS[1]} strokeWidth={1.5}/>
        {sets[0]&&<text x={50} y={30} style={{fontSize:9,fill:VIS_COLORS[0],fontWeight:700}}>{sets[0].label}</text>}
        {sets[1]&&<text x={120} y={30} style={{fontSize:9,fill:VIS_COLORS[1],fontWeight:700}}>{sets[1].label}</text>}
        {inter&&<text x={100} y={65} textAnchor="middle" style={{fontSize:8,fill:C.tx,fontWeight:600}}>{inter.label}</text>}
      </svg>
    </div>);
  }

  // NETWORK
  if (type==="network") {
    const nodes=chart_data.nodes||[], edges=chart_data.edges||[];
    const cx=100,cy=80,r=55,n=nodes.length; const pm={};
    nodes.forEach((nd,i)=>{const a=(2*Math.PI*i/n)-Math.PI/2;pm[nd.id]={x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};});
    return wrap(<svg viewBox="0 0 200 160" style={{width:"100%",maxWidth:240,margin:"0 auto",display:"block"}}>
      {edges.map((e,i)=>{const f=pm[e.from],t=pm[e.to];if(!f||!t)return null;return <g key={i}>
        <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={C.bd} strokeWidth={1}/>
        {e.label&&<text x={(f.x+t.x)/2} y={(f.y+t.y)/2-4} textAnchor="middle" style={{fontSize:7,fill:C.txD}}>{e.label}</text>}
      </g>;})}
      {nodes.map((nd,i)=>{const p=pm[nd.id];return <g key={i}><circle cx={p.x} cy={p.y} r={14} fill={VIS_COLORS[i%VIS_COLORS.length]} fillOpacity={0.3} stroke={VIS_COLORS[i%VIS_COLORS.length]} strokeWidth={1.5}/>
        <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" style={{fontSize:7,fill:C.tx,fontWeight:600}}>{nd.label}</text></g>;})}
    </svg>);
  }

  // PROGRESS
  if (type==="progress") {
    const steps=chart_data.steps||[], cur=chart_data.current??steps.length;
    return wrap(<div style={{display:"flex",alignItems:"center",gap:4}}>
      {steps.map((s,i)=>{const done=(s.status==="done")||i<cur,isCur=i===cur;
        return <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{width:24,height:24,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,
            background:done?C.ac:isCur?"#F59E0B":"rgba(255,255,255,0.06)",color:done||isCur?"#fff":C.txD,border:isCur?"2px solid #F59E0B":"none"}}>{done?"✓":i+1}</div>
          <div style={{fontSize:9,color:done?C.ac:C.txD,marginTop:3,textAlign:"center"}}>{s.label}</div>
        </div>;
      })}
    </div>);
  }

  // FALLBACK
  return wrap(<div style={{padding:8,fontSize:11,color:C.txD,textAlign:"center"}}>
    <div style={{fontSize:12,fontWeight:600,color:C.txM,marginBottom:4}}>📊 {type.toUpperCase()}</div>
    <pre style={{fontSize:10,color:C.txD,textAlign:"left",whiteSpace:"pre-wrap",maxHeight:120,overflow:"auto"}}>{JSON.stringify(chart_data,null,2)}</pre>
  </div>);
}

// ═══════════════════════════════════════
// INSERT CUT CARD
// ═══════════════════════════════════════
const IC_TYPE = { A:{icon:"🎨",label:"회상 일러스트",color:"#8B5CF6"}, B:{icon:"🏢",label:"공식 이미지/유튜브",color:"#3B82F6"}, C:{icon:"🏆",label:"작품/성과물",color:"#F59E0B"} };

function InsertCutCard({ item, active, onClick, verdict, onVerdict, onRegenerate, busy }) {
  const [open,setOpen]=useState(false),[cp,setCp]=useState(false);
  const info=IC_TYPE[item.type]||IC_TYPE.B;
  const blockIdx = (item.block_range||[])[0];
  const borderC=verdict==="use"?"#22C55E":verdict==="discard"?"rgba(239,68,68,0.4)":active?info.color:C.bd;
  const cardBg=verdict==="discard"?"rgba(239,68,68,0.05)":active?`${info.color}11`:C.sf;
  return <div onClick={()=>onClick&&onClick(blockIdx)} style={{border:`1px solid ${borderC}`,borderRadius:10,padding:"10px 12px",marginBottom:8,
    background:cardBg,cursor:"pointer",transition:"all 0.15s",opacity:verdict==="discard"?0.5:1,
    boxShadow:active&&!verdict?`0 0 0 2px ${info.color}44`:"none"}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
      <span style={{fontSize:13}}>{info.icon}</span>
      <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:`${info.color}22`,color:info.color}}>Type {item.type}: {item.type_name||info.label}</span>
      {item.speaker&&<span style={{fontSize:10,color:C.txM}}>{item.speaker}</span>}
      <span style={{flex:1}}/>
      <button onClick={e=>{e.stopPropagation();onRegenerate&&onRegenerate()}} disabled={busy}
        title="이 카드 재생성"
        style={{fontSize:9,fontWeight:600,padding:"2px 6px",borderRadius:4,cursor:busy?"not-allowed":"pointer",
          border:`1px solid ${C.bd}`,background:"rgba(255,255,255,0.04)",color:C.txD,flexShrink:0}}>🔄</button>
      <span style={{fontSize:10,color:C.txD,fontFamily:"monospace"}}>#{blockIdx}</span>
    </div>
    <div style={{fontSize:13,fontWeight:600,color:C.tx,marginBottom:4,textDecoration:verdict==="discard"?"line-through":"none"}}>{item.title}</div>
    <div style={{fontSize:11,color:C.txM,marginBottom:4,fontStyle:"italic",borderLeft:`2px solid ${info.color}`,paddingLeft:8}}>"{item.trigger_quote}"</div>
    {item.type==="A"&&item.image_prompt&&<div style={{padding:"6px 10px",borderRadius:6,background:"rgba(139,92,246,0.08)",border:"1px solid rgba(139,92,246,0.2)",marginBottom:4}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
        <span style={{fontSize:10,fontWeight:600,color:"#8B5CF6"}}>🖼 이미지 프롬프트</span>
        <button onClick={()=>{navigator.clipboard.writeText(item.image_prompt);setCp(true);setTimeout(()=>setCp(false),1500)}}
          style={{fontSize:9,padding:"1px 6px",borderRadius:3,border:`1px solid ${cp?"#22C55E":"#8B5CF6"}`,background:cp?"rgba(34,197,94,0.15)":"transparent",color:cp?"#22C55E":"#8B5CF6",cursor:"pointer"}}>{cp?"✓ 복사됨":"복사"}</button>
      </div>
      <div style={{fontSize:10,color:C.txD,lineHeight:1.4}}>{item.image_prompt}</div>
    </div>}
    {item.type==="B"&&<div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:4}}>
      {item.search_keywords?.length>0&&<div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {item.search_keywords.map((kw,i)=><span key={i} style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:"rgba(59,130,246,0.12)",color:"#3B82F6",border:"1px solid rgba(59,130,246,0.2)"}}>{kw}</span>)}
      </div>}
      {item.youtube_search&&<div style={{padding:"4px 8px",borderRadius:4,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.15)"}}>
        <span style={{fontSize:10,fontWeight:600,color:"#EF4444"}}>▶ YouTube: </span>
        <span style={{fontSize:10,color:C.txM}}>{item.youtube_search.query}</span>
      </div>}
    </div>}
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"rgba(255,255,255,0.06)",color:C.txD}}>
        {item.source_type==="illustration"?"일러스트 제작":item.source_type==="official_image"?"공식 이미지":item.source_type==="official_youtube"?"공식 유튜브":item.source_type==="guest_provided"?"게스트 제공":item.source_type}</span>
      {item.asset_note&&<span style={{fontSize:9,color:"#F59E0B"}}>⚠ {item.asset_note}</span>}
    </div>
    <div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}>
      <button onClick={e=>{e.stopPropagation();setOpen(!open)}} style={{fontSize:11,color:C.ac,background:"none",border:"none",cursor:"pointer",padding:"2px 0"}}>
        {open?"접기 ▲":"상세 ▼"}</button>
      <div style={{marginLeft:"auto",display:"flex",gap:3}}>
        {[{k:"use",l:"사용",c:"#22C55E",bg:"rgba(34,197,94,0.15)"},{k:"discard",l:"폐기",c:"#EF4444",bg:"rgba(239,68,68,0.15)"}].map(o=>
          <button key={o.k} onClick={e=>{e.stopPropagation();onVerdict&&onVerdict(o.k)}}
            style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
              border:`1px solid ${verdict===o.k?o.c:"transparent"}`,background:verdict===o.k?o.bg:"rgba(255,255,255,0.04)",
              color:verdict===o.k?o.c:C.txD}}>{o.l}</button>)}
      </div>
    </div>
    {open&&<div style={{background:"rgba(0,0,0,0.25)",borderRadius:8,padding:10,marginTop:4,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:12,color:C.txM,marginBottom:4}}><b>트리거 사유:</b> {item.trigger_reason}</div>
      <div style={{fontSize:12,color:C.txM}}><b>편집자 지시:</b> {item.instruction}</div>
    </div>}
  </div>;
}

// ═══════════════════════════════════════
// APP
// ═══════════════════════════════════════
export default function App() {
  const [inputText, setInputText] = useState("");
  const [blocks, setBlocks] = useState([]);
  const [visualGuides, setVisualGuides] = useState([]);
  const [insertCuts, setInsertCuts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("visuals");
  const [loaded, setLoaded] = useState(false);
  const [aBlock, setABlock] = useState(null);
  const [verdicts, setVerdicts] = useState({});
  const [sessionId, setSessionId] = useState(null);
  const [shareUrl, setShareUrl] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fn, setFn] = useState("");
  const [autoSaveStatus, setAutoSaveStatus] = useState("");
  const autoSaveTimer = useRef(null);
  const lastSavedRef = useRef(null);
  const [sessions, setSessions] = useState(null); // 세션 목록

  // 텍스트 선택 기반 구간 추천
  const [textSel, setTextSel] = useState(null);

  const lRef = useRef(null);
  const rRef = useRef(null);
  const bEls = useRef({});
  const cEls = useRef({});

  // ── 앱 마운트 시 URL ?s= 파라미터로 세션 로드 + 세션 목록 로드 ──
  useState(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("s");
    if (sid) {
      fetch(`${WORKER_URL}/load/${sid}`).then(r => r.json()).then(data => {
        if (data.error) return;
        setBlocks(data.blocks || []);
        setVisualGuides(data.visualGuides || []);
        setInsertCuts(data.insertCuts || []);
        setVerdicts(data.verdicts || {});
        setTab(data.tab || "visuals");
        setFn(data.fn || "");
        setLoaded(true);
        setSessionId(sid);
        lastSavedRef.current = JSON.stringify(data);
      }).catch(() => {});
    }
    // 세션 목록 로드
    fetch(`${WORKER_URL}/sessions`).then(r=>r.json()).then(d=>{
      if(d.sessions) setSessions(d.sessions);
    }).catch(()=>{});
  });

  // 세션 불러오기
  const loadSession = useCallback(async (sid) => {
    setErr(null); setProg("📥 세션 불러오는 중...");
    try {
      const r = await fetch(`${WORKER_URL}/load/${sid}`);
      const data = await r.json();
      if (data.error) { setErr(data.error); setProg(""); return; }
      setBlocks(data.blocks || []);
      setVisualGuides(data.visualGuides || []);
      setInsertCuts(data.insertCuts || []);
      setVerdicts(data.verdicts || {});
      setTab(data.tab || "visuals");
      setFn(data.fn || "");
      setLoaded(true);
      setSessionId(sid);
      lastSavedRef.current = JSON.stringify(data);
      window.history.replaceState({}, "", `${window.location.pathname}?s=${sid}`);
      setProg("✅ 세션 불러옴");
    } catch (e) { setErr(`세션 로드 실패: ${e.message}`); setProg(""); }
  }, []);

  const deleteSession = useCallback(async (sid) => {
    try {
      await fetch(`${WORKER_URL}/session-delete`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({id:sid}) });
      setSessions(prev => prev?.filter(s => s.id !== sid));
    } catch {}
  }, []);

  // 공유 (저장 + URL 생성)
  const handleShare = useCallback(async () => {
    setSaving(true); setErr(null);
    try {
      const payload = { blocks, visualGuides, insertCuts, verdicts, tab };
      if (sessionId) payload.id = sessionId;
      const r = await fetch(`${WORKER_URL}/save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setSessionId(d.id);
      const url = `${window.location.origin}${window.location.pathname}?s=${d.id}`;
      setShareUrl(url);
      window.history.replaceState({}, "", `${window.location.pathname}?s=${d.id}`);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }, [blocks, visualGuides, insertCuts, verdicts, tab, sessionId]);
  // 텍스트 선택 감지 (mouseup 시)
  const onTextMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      // 클릭만 한 경우 — 어떤 블록인지 판별해서 scrollTo
      return;
    }
    const selectedText = sel.toString().trim();
    if (selectedText.length < 10) return; // 너무 짧으면 무시

    // 선택 영역이 속한 블록 인덱스들 찾기
    const range = sel.getRangeAt(0);
    const container = lRef.current;
    if (!container || !container.contains(range.startContainer)) return;

    const blockIndices = new Set();
    for (const [idx, el] of Object.entries(bEls.current)) {
      if (el && sel.containsNode(el, true)) blockIndices.add(parseInt(idx));
    }

    const indices = [...blockIndices].sort((a, b) => a - b);
    if (indices.length === 0) return;

    const preview = selectedText.length > 80 ? selectedText.substring(0, 80) + "…" : selectedText;
    setTextSel({ text: selectedText, blockIndices: indices, preview });
  }, []);

  const clearTextSel = useCallback(() => {
    setTextSel(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // 선택된 텍스트로 추천 생성
  const handleTextSelGenerate = useCallback(async (mode) => {
    if (!textSel || blocks.length === 0) return;
    setBusy(true); setErr(null);
    const endpoint = mode === "visuals" ? "/visuals" : "/insert-cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    // 선택 영역이 포함된 블록들을 보내되, 선택 텍스트를 추가 힌트로 전달
    const rangeBlocks = blocks.filter(b => textSel.blockIndices.includes(b.index));
    try {
      const blockLabel = textSel.blockIndices.length === 1
        ? `블록 #${textSel.blockIndices[0]}` : `블록 #${textSel.blockIndices[0]}~#${textSel.blockIndices[textSel.blockIndices.length - 1]}`;
      setProg(`${label} 생성 중 (${blockLabel}, 선택 ${textSel.text.length}자)...`);
      // 선택 텍스트를 analysis.selected_text로 전달 → Worker가 프롬프트에 주입
      const d = await apiCall(endpoint, {
        blocks: rangeBlocks,
        analysis: { selected_text: textSel.text },
      });
      const items = (d.result?.[key] || []).map((v, i) => ({ ...v, id: Date.now() + i }));
      if (mode === "visuals") { setVisualGuides(prev => [...prev, ...items]); setTab("visuals"); }
      else { setInsertCuts(prev => [...prev, ...items]); setTab("inserts"); }
      setProg(`✅ ${label} 완료 — ${items.length}건 추가`);
      clearTextSel();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [textSel, blocks, clearTextSel]);

  // 카드 1건 재생성: 해당 block_range로 다시 호출 → 기존 카드 교체
  const handleRegenerate = useCallback(async (item, mode, preferredType) => {
    setBusy(true); setErr(null);
    const range = item.block_range || [0, 0];
    const rangeBlocks = blocks.filter(b => b.index >= range[0] && b.index <= (range[1] || range[0]));
    if (rangeBlocks.length === 0) { setBusy(false); return; }
    const endpoint = mode === "visuals" ? "/visuals" : "/insert-cuts";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    try {
      const tl = preferredType ? ` (${preferredType})` : "";
      setProg(`🔄 ${label} 재생성 중${tl} (블록 #${range[0]}~#${range[1]||range[0]})...`);
      const payload = { blocks: rangeBlocks };
      if (preferredType) payload.preferred_type = preferredType;
      const d = await apiCall(endpoint, payload);
      const newItems = (d.result?.[key] || []).map((v, i) => ({ ...v, id: Date.now() + i }));
      if (newItems.length === 0) { setProg("⚠ 재생성 결과 없음"); setBusy(false); return; }
      // 기존 카드 1건을 새 결과로 교체 (첫 번째 결과 사용, 나머지는 추가)
      const vKey = mode === "visuals" ? `vis-${item.id}` : `ic-${item.id}`;
      if (mode === "visuals") {
        setVisualGuides(prev => {
          const idx = prev.findIndex(v => v.id === item.id);
          if (idx === -1) return [...prev, ...newItems];
          const next = [...prev];
          next.splice(idx, 1, ...newItems);
          return next;
        });
      } else {
        setInsertCuts(prev => {
          const idx = prev.findIndex(v => v.id === item.id);
          if (idx === -1) return [...prev, ...newItems];
          const next = [...prev];
          next.splice(idx, 1, ...newItems);
          return next;
        });
      }
      // 기존 verdict 제거
      setVerdicts(prev => { const n = { ...prev }; delete n[vKey]; return n; });
      setProg(`✅ ${label} 재생성 완료 (${newItems.length}건)`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [blocks]);

  const scrollTo = useCallback((blockIdx) => {
    setABlock(blockIdx);
    const HEADER_H = 40;
    const bEl = bEls.current[blockIdx];
    if (bEl && lRef.current) {
      const cr = lRef.current.getBoundingClientRect();
      const er = bEl.getBoundingClientRect();
      const target = er.top - cr.top + lRef.current.scrollTop - HEADER_H - 20;
      lRef.current.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
    // 오른쪽: blockIdx에 해당하는 카드 찾기 (data-card-block 속성으로)
    if (rRef.current) {
      const cardEl = rRef.current.querySelector(`[data-card-block="${blockIdx}"]`);
      if (cardEl) {
        const cr = rRef.current.getBoundingClientRect();
        const er = cardEl.getBoundingClientRect();
        const target = er.top - cr.top + rRef.current.scrollTop - HEADER_H - 20;
        rRef.current.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      }
    }
  }, []);

  // ── 파일 업로드 ──
  const onFileUpload = useCallback(async(file)=>{
    if(!file)return; setErr(null); setProg("📄 파일 읽는 중...");
    try {
      if(file.name.endsWith(".docx")){
        const buf=await file.arrayBuffer();
        try{
          const tc=await parseDocxWithTrackChanges(buf.slice(0));
          if(tc.hasTrackChanges){
            const p=parseBlocks(tc.cleanText);if(p.length===0){setErr("파싱 실패");setProg("");return;}
            setBlocks(p);setInputText(tc.cleanText);setFn(file.name);setLoaded(true);
            setVisualGuides([]);setInsertCuts([]);setVerdicts({});
            setProg(`✅ ${file.name} — 삭제선 감지 (${p.length}블록)`);return;
          }
        }catch(e){console.warn("삭제선 파싱 실패:",e.message);}
        const res=await mammoth.extractRawText({arrayBuffer:buf});
        const p=parseBlocks(res.value);if(p.length===0){setErr("파싱 실패");setProg("");return;}
        setBlocks(p);setInputText(res.value);setFn(file.name);setLoaded(true);
        setVisualGuides([]);setInsertCuts([]);setVerdicts({});setProg(`✅ ${file.name} — ${p.length}블록`);
      }else{
        const text=await file.text();const p=parseBlocks(text);if(p.length===0){setErr("파싱 실패");setProg("");return;}
        setBlocks(p);setInputText(text);setFn(file.name);setLoaded(true);
        setVisualGuides([]);setInsertCuts([]);setVerdicts({});setProg(`✅ ${file.name} — ${p.length}블록`);
      }
    }catch(e){setErr(`파일 처리 실패: ${e.message}`);setProg("");}
  },[]);

  // ── 3분 자동저장 ──
  useEffect(()=>{
    if(!loaded||blocks.length===0)return;
    if(autoSaveTimer.current)clearTimeout(autoSaveTimer.current);
    setAutoSaveStatus("pending");
    autoSaveTimer.current=setTimeout(async()=>{
      const state={blocks,visualGuides,insertCuts,verdicts,tab,inputText,fn};
      const sj=JSON.stringify(state);if(sj===lastSavedRef.current)return;
      try{setAutoSaveStatus("saving");
        const pl={...state};if(sessionId)pl.id=sessionId;
        const r=await fetch(`${WORKER_URL}/save`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pl)});
        const d=await r.json();if(d.id&&!sessionId)setSessionId(d.id);
        lastSavedRef.current=sj;setAutoSaveStatus("saved");setTimeout(()=>setAutoSaveStatus(""),5000);
      }catch{setAutoSaveStatus("");}
    },AUTOSAVE_INTERVAL);
    return()=>{if(autoSaveTimer.current)clearTimeout(autoSaveTimer.current);};
  },[visualGuides,insertCuts,verdicts,loaded]);

  const handleLoad = useCallback(() => {
    const parsed = parseBlocks(inputText);
    if (parsed.length === 0) { setErr("블록을 파싱할 수 없습니다."); return; }
    setBlocks(parsed); setLoaded(true); setErr(null);
    setVisualGuides([]); setInsertCuts([]); setABlock(null); setTextSel(null);
  }, [inputText]);

  const handleGenerate = useCallback(async (mode) => {
    if (blocks.length === 0) return;
    setBusy(true); setErr(null);
    const endpoint = mode === "visuals" ? "/visuals" : "/insert-cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    try {
      const CHUNK = 20000;
      const chunks = []; let cur = [], curLen = 0;
      for (const b of blocks) {
        if (curLen + b.text.length > CHUNK && cur.length > 0) { chunks.push(cur); cur = []; curLen = 0; }
        cur.push(b); curLen += b.text.length;
      }
      if (cur.length > 0) chunks.push(cur);
      let all = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        setProg(`${label} 생성 중 (${ci + 1}/${chunks.length})...`);
        const d = await apiCall(endpoint, { blocks: chunks[ci], chunk_index: ci, total_chunks: chunks.length, existing_count: all.length });
        const items = d.result?.[mode === "visuals" ? "visual_guides" : "insert_cuts"] || [];
        all.push(...items);
        if (ci < chunks.length - 1) { setProg("청크 간 대기 중... ☕"); await delay(3000); }
      }
      all = all.map((v, i) => ({ ...v, id: Date.now() + i }));
      if (mode === "visuals") { setVisualGuides(prev => [...prev, ...all]); setTab("visuals"); }
      else { setInsertCuts(prev => [...prev, ...all]); setTab("inserts"); }
      setProg(`✅ ${label} 완료 — ${all.length}건 추가`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [blocks]);

  const blockHasCard = useMemo(() => {
    const set = new Set();
    const items = tab === "visuals" ? visualGuides : insertCuts;
    for (const item of items) {
      const range = item.block_range || [];
      for (let i = range[0]; i <= (range[1] || range[0]); i++) set.add(i);
    }
    return set;
  }, [tab, visualGuides, insertCuts]);


  return <div style={{height:"100vh",background:C.bg,color:C.tx,fontFamily:FN,display:"flex",flexDirection:"column"}}>
    <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",height:52,
      borderBottom:`1px solid ${C.bd}`,background:C.sf,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18,fontWeight:800}}><span style={{color:C.ac}}>V</span>isual Guide</span>
        <span style={{fontSize:10,padding:"2px 6px",borderRadius:3,fontWeight:600,background:"rgba(34,197,94,0.15)",color:C.ok}}>v2.3</span>
      </div>
      {loaded && <div style={{display:"flex",gap:2,background:"rgba(255,255,255,0.04)",borderRadius:7,padding:2}}>
        {[["visuals","📊 시각화"],["inserts","🎬 인서트 컷"]].map(([id,l])=>
          <button key={id} onClick={()=>setTab(id)} style={{padding:"5px 14px",borderRadius:5,border:"none",cursor:"pointer",
            fontSize:12,fontWeight:tab===id?600:400,background:tab===id?C.ac:"transparent",color:tab===id?"#fff":C.txM}}>
            {l}{id==="visuals"&&visualGuides.length>0?` (${visualGuides.length})`:""}{id==="inserts"&&insertCuts.length>0?` (${insertCuts.length})`:""}
          </button>)}
      </div>}
      {loaded && <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {autoSaveStatus&&<span style={{fontSize:10,color:autoSaveStatus==="saved"?C.ok:autoSaveStatus==="saving"?C.ac:C.txD}}>
            {autoSaveStatus==="pending"?"⏳ 자동저장 대기":autoSaveStatus==="saving"?"💾 저장 중...":"✓ 저장됨"}</span>}
          <button onClick={handleShare} disabled={saving}
            style={{padding:"5px 14px",borderRadius:6,border:"none",cursor:saving?"not-allowed":"pointer",
              background:`linear-gradient(135deg,${C.ac},#7C3AED)`,color:"#fff",fontSize:12,fontWeight:600,
              boxShadow:"0 2px 8px rgba(74,108,247,0.3)"}}>
            {saving?"저장 중...":sessionId?"↑ 업데이트":"📤 공유"}</button>
        </div>}
    </header>
    {/* 공유 URL 모달 */}
    {shareUrl && (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:100,
        display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShareUrl(null)}>
        <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,width:440,border:`1px solid ${C.bd}`}}>
          <div style={{fontSize:16,fontWeight:700,marginBottom:16}}>📤 공유 링크</div>
          <div style={{padding:"10px 14px",borderRadius:8,background:"rgba(0,0,0,0.3)",border:`1px solid ${C.bd}`,
            fontSize:13,color:C.ac,wordBreak:"break-all",marginBottom:12}}>{shareUrl}</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{navigator.clipboard.writeText(shareUrl)}}
              style={{flex:1,padding:"10px",borderRadius:8,border:"none",background:C.ac,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>
              📋 복사</button>
            <button onClick={()=>setShareUrl(null)}
              style={{padding:"10px 20px",borderRadius:8,border:`1px solid ${C.bd}`,background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>
              닫기</button>
          </div>
        </div>
      </div>
    )}
    <main style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
      {err && <div style={{padding:"8px 20px",background:"rgba(239,68,68,0.1)",color:C.err,fontSize:12,borderBottom:`1px solid rgba(239,68,68,0.2)`}}>
        ⚠ {err} <button onClick={()=>setErr(null)} style={{marginLeft:8,background:"none",border:"none",color:C.err,cursor:"pointer"}}>✕</button></div>}
      {(busy||prog) && <div style={{padding:"6px 20px",background:C.acS,fontSize:12,color:C.ac,borderBottom:`1px solid ${C.bd}`}}>{prog}</div>}
      {!loaded ? (
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:40}}>
          <div style={{maxWidth:700,width:"100%"}}>
            <h2 style={{fontSize:20,fontWeight:700,marginBottom:8}}>Visual Guide</h2>
            <p style={{fontSize:13,color:C.txD,marginBottom:16}}>교정본 파일을 업로드하여 시각화 & 인서트 컷 가이드를 생성하세요</p>
            <FileUploader onFileLoad={onFileUpload} busy={busy}/>
            <div style={{margin:"16px 0",display:"flex",alignItems:"center",gap:12}}>
              <div style={{flex:1,height:1,background:C.bd}}/><span style={{fontSize:11,color:C.txD}}>또는 텍스트 직접 입력</span><div style={{flex:1,height:1,background:C.bd}}/>
            </div>
            <textarea value={inputText} onChange={e=>setInputText(e.target.value)}
              placeholder={"홍재의 0:00\n오늘 주제는 AI 에이전트입니다.\n\n강정수 0:15\n에이전트 AI라는 게 사실 최근에..."}
              rows={8} style={{width:"100%",padding:14,borderRadius:10,border:`1px solid ${C.bd}`,background:"rgba(0,0,0,0.3)",
                color:C.tx,fontSize:13,fontFamily:FN,lineHeight:1.6,resize:"vertical",outline:"none"}}/>
            <button onClick={handleLoad} disabled={!inputText.trim()}
              style={{marginTop:12,padding:"12px 32px",borderRadius:10,border:"none",
                background:inputText.trim()?`linear-gradient(135deg,${C.ac},#7C3AED)`:"rgba(255,255,255,0.06)",
                color:inputText.trim()?"#fff":C.txD,fontSize:15,fontWeight:700,cursor:inputText.trim()?"pointer":"not-allowed",
                boxShadow:inputText.trim()?"0 4px 16px rgba(74,108,247,0.3)":"none"}}>
              텍스트로 시작</button>
            {/* 저장된 세션 목록 */}
            {sessions && sessions.length > 0 && <>
              <div style={{margin:"20px 0 10px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1,height:1,background:C.bd}}/><span style={{fontSize:11,color:C.txD}}>저장된 세션</span><div style={{flex:1,height:1,background:C.bd}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {sessions.slice(0,10).map(s => (
                  <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:8,
                    border:`1px solid ${C.bd}`,background:C.sf,cursor:"pointer",transition:"all 0.15s"}}
                    onClick={()=>loadSession(s.id)}
                    onMouseEnter={e=>e.currentTarget.style.borderColor=C.ac}
                    onMouseLeave={e=>e.currentTarget.style.borderColor=C.bd}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:C.tx}}>{s.fn||"제목 없음"}</div>
                      <div style={{fontSize:10,color:C.txD,marginTop:2}}>
                        {s.blockCount}블록 · 시각화 {s.visCount||0}건 · 인서트 {s.icCount||0}건
                        {s.savedAt && <span style={{marginLeft:8}}>{new Date(s.savedAt).toLocaleString("ko-KR",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span>}
                      </div>
                    </div>
                    <button onClick={e=>{e.stopPropagation();deleteSession(s.id)}}
                      style={{fontSize:10,padding:"2px 6px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txD,cursor:"pointer"}}>✕</button>
                  </div>
                ))}
              </div>
            </>}
          </div>
        </div>
      ) : (
        <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
          {/* 왼쪽: 블록 뷰 (텍스트 선택으로 구간 추천) */}
          <div ref={lRef} onMouseUp={onTextMouseUp} style={{flex:1,overflowY:"auto",borderRight:`1px solid ${C.bd}`}}>
            <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,borderBottom:`1px solid ${C.bd}`,
              position:"sticky",top:0,background:C.bg,zIndex:2,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>{fn&&`📄 ${fn} · `}교정본 ({blocks.length}블록) — <span style={{fontWeight:400}}>텍스트 드래그로 구간 추천</span></span>
              <button onClick={()=>{setLoaded(false);setBlocks([]);setVisualGuides([]);setInsertCuts([]);setABlock(null);setTextSel(null);setFn("");setSessionId(null);setAutoSaveStatus("");window.history.replaceState({},"",window.location.pathname)}}
                style={{fontSize:10,padding:"2px 8px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txM,cursor:"pointer"}}>새로 입력</button>
            </div>
            {blocks.map(b => {
              const isActive = aBlock === b.index;
              const hasCard = blockHasCard.has(b.index);
              const inSel = textSel && textSel.blockIndices.includes(b.index);
              // "사용" 판정된 카드들 찾기
              const usedVisuals = visualGuides.filter(v => (v.block_range||[])[0] === b.index && verdicts[`vis-${v.id}`] === "use");
              const usedCuts = insertCuts.filter(ic => (ic.block_range||[])[0] === b.index && verdicts[`ic-${ic.id}`] === "use");
              return <div key={b.index}>
              <div ref={el=>{if(el)bEls.current[b.index]=el}}
                onClick={()=>{ if(!window.getSelection()?.toString().trim()) scrollTo(b.index); }}
                style={{padding:"10px 16px",borderBottom:`1px solid ${C.bd}22`,cursor:"text",transition:"all 0.1s",
                  borderLeft:`4px solid ${inSel?"#F59E0B":isActive?"#A855F7":hasCard?"#3B82F644":"transparent"}`,
                  background:inSel?"rgba(245,158,11,0.06)":isActive?"rgba(168,85,247,0.08)":"transparent"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <span style={{fontSize:10,fontWeight:700,color:inSel?"#F59E0B":isActive?"#A855F7":C.txD,fontFamily:"monospace",
                    background:inSel?"rgba(245,158,11,0.2)":isActive?"rgba(168,85,247,0.15)":"rgba(255,255,255,0.06)",
                    padding:"1px 5px",borderRadius:3}}>#{b.index}</span>
                  <span style={{fontSize:11,fontWeight:600,color:isActive?C.ac:C.txM}}>{b.speaker}</span>
                  <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{b.timestamp}</span>
                  {hasCard && <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,
                    background:tab==="visuals"?"rgba(59,130,246,0.12)":"rgba(245,158,11,0.12)",
                    color:tab==="visuals"?"#3B82F6":"#F59E0B"}}>{tab==="visuals"?"📊":"🎬"}</span>}
                </div>
                <div style={{fontSize:13,color:C.tx,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{b.text}</div>
              </div>
              {/* 인라인: "사용" 판정된 시각화 카드 */}
              {usedVisuals.map(v => (
                <div key={`inline-vis-${v.id}`} style={{margin:"2px 16px 4px",padding:"8px 12px",borderRadius:8,
                  border:"1px solid rgba(59,130,246,0.3)",background:"rgba(59,130,246,0.06)",
                  display:"flex",alignItems:"flex-start",gap:8}}>
                  <span style={{fontSize:11,color:"#3B82F6",fontWeight:700,flexShrink:0}}>📊</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#3B82F6",marginBottom:4}}>{v.title}</div>
                    <VisualMockup type={v.type} chart_data={v.chart_data}/>
                  </div>
                </div>
              ))}
              {/* 인라인: "사용" 판정된 인서트 컷 카드 */}
              {usedCuts.map(ic => {
                const info = IC_TYPE[ic.type] || IC_TYPE.B;
                return <div key={`inline-ic-${ic.id}`} style={{margin:"2px 16px 4px",padding:"8px 12px",borderRadius:8,
                  border:`1px solid ${info.color}44`,background:`${info.color}0a`,
                  display:"flex",alignItems:"flex-start",gap:8}}>
                  <span style={{fontSize:11,color:info.color,fontWeight:700,flexShrink:0}}>{info.icon}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:600,color:info.color}}>{ic.title}</div>
                    <div style={{fontSize:11,color:C.txD,marginTop:2}}>{ic.instruction}</div>
                    {ic.type==="A"&&ic.image_prompt&&<div style={{fontSize:10,color:C.txD,marginTop:2,fontStyle:"italic"}}>🖼 {ic.image_prompt.substring(0,80)}...</div>}
                  </div>
                </div>;
              })}
              </div>;
            })}
          </div>
          {/* 플로팅 액션 바: 텍스트 선택 시 */}
          {textSel && !busy && (
            <div style={{position:"absolute",bottom:20,left:"50%",transform:"translateX(-70%)",zIndex:10,
              display:"flex",alignItems:"center",gap:8,padding:"10px 16px",borderRadius:12,
              background:"rgba(30,30,40,0.95)",border:"1px solid #F59E0B",
              boxShadow:"0 8px 32px rgba(0,0,0,0.5)",backdropFilter:"blur(8px)",maxWidth:600}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,fontWeight:700,color:"#F59E0B",marginBottom:2}}>
                  선택 구간 ({textSel.text.length}자)
                </div>
                <div style={{fontSize:10,color:C.txD,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  "{textSel.preview}"
                </div>
              </div>
              <button onClick={()=>handleTextSelGenerate("visuals")}
                style={{fontSize:11,fontWeight:600,padding:"6px 14px",borderRadius:6,border:"none",cursor:"pointer",
                  background:"rgba(59,130,246,0.9)",color:"#fff",whiteSpace:"nowrap"}}>📊 시각화 추천</button>
              <button onClick={()=>handleTextSelGenerate("inserts")}
                style={{fontSize:11,fontWeight:600,padding:"6px 14px",borderRadius:6,border:"none",cursor:"pointer",
                  background:"rgba(245,158,11,0.9)",color:"#fff",whiteSpace:"nowrap"}}>🎬 인서트 컷</button>
              <button onClick={clearTextSel}
                style={{fontSize:11,padding:"6px 10px",borderRadius:6,border:`1px solid ${C.bd}`,background:"transparent",
                  color:C.txM,cursor:"pointer"}}>✕</button>
            </div>
          )}
          {/* 오른쪽: 결과 패널 */}
          <div ref={rRef} style={{width:440,minWidth:440,overflowY:"auto",background:"rgba(0,0,0,0.12)"}}>
            <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.sf,zIndex:2}}>
              <div style={{display:"flex",gap:4}}>
                <button onClick={()=>handleGenerate("visuals")} disabled={busy}
                  style={{flex:1,fontSize:11,fontWeight:600,padding:"8px 10px",borderRadius:6,border:"none",cursor:busy?"not-allowed":"pointer",
                    background:busy?"rgba(59,130,246,0.3)":"rgba(59,130,246,0.8)",color:"#fff"}}>
                  {busy&&tab==="visuals"?"생성 중...":"📊 전체 시각화 생성"}</button>
                <button onClick={()=>handleGenerate("inserts")} disabled={busy}
                  style={{flex:1,fontSize:11,fontWeight:600,padding:"8px 10px",borderRadius:6,border:"none",cursor:busy?"not-allowed":"pointer",
                    background:busy?"rgba(245,158,11,0.3)":"rgba(245,158,11,0.8)",color:"#fff"}}>
                  {busy&&tab==="inserts"?"생성 중...":"🎬 전체 인서트 컷 생성"}</button>
              </div>
              {(visualGuides.length>0||insertCuts.length>0) && <div style={{display:"flex",gap:4,marginTop:4}}>
                {visualGuides.length>0&&tab==="visuals"&&<button onClick={()=>setVisualGuides([])}
                  style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txD,cursor:"pointer"}}>
                  🗑 초기화 ({visualGuides.length}건)</button>}
                {insertCuts.length>0&&tab==="inserts"&&<button onClick={()=>setInsertCuts([])}
                  style={{fontSize:10,padding:"3px 8px",borderRadius:4,border:`1px solid ${C.bd}`,background:"transparent",color:C.txD,cursor:"pointer"}}>
                  🗑 초기화 ({insertCuts.length}건)</button>}
              </div>}
            </div>
            <div style={{padding:"6px 10px"}}>
              {tab==="visuals" && <>
                {visualGuides.length===0&&<p style={{padding:30,textAlign:"center",fontSize:12,color:C.txD}}>📊 전체 생성 또는 블록 드래그 → 구간 추천</p>}
                {visualGuides.map((v,i)=>{
                  const blockIdx=(v.block_range||[])[0]; const isActive=aBlock===blockIdx;
                  const vKey=`vis-${v.id}`; const vd=verdicts[vKey]||null;
                  const borderC=vd==="use"?"#22C55E":vd==="discard"?"rgba(239,68,68,0.4)":isActive?"#3B82F6":C.bd;
                  const cardBg=vd==="discard"?"rgba(239,68,68,0.05)":isActive?"rgba(59,130,246,0.08)":C.sf;
                  return <div key={`v-${v.id||i}`} ref={el=>{if(el&&!cEls.current[blockIdx])cEls.current[blockIdx]=el}}
                    data-card-block={blockIdx}
                    onClick={()=>scrollTo(blockIdx)}
                    style={{border:`1px solid ${borderC}`,borderRadius:10,padding:"10px 12px",marginBottom:8,
                      background:cardBg,cursor:"pointer",transition:"all 0.15s",opacity:vd==="discard"?0.5:1,
                      boxShadow:isActive&&!vd?"0 0 0 2px rgba(59,130,246,0.3)":"none"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                      <span style={{fontSize:13}}>📊</span>
                      <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
                        background:`${v.priority==="high"?"#EF4444":v.priority==="medium"?"#F59E0B":"#94A3B8"}22`,
                        color:v.priority==="high"?"#EF4444":v.priority==="medium"?"#F59E0B":"#94A3B8",textTransform:"uppercase"}}>{v.priority}</span>
                      <span style={{fontSize:11,fontWeight:600,color:C.tx,flex:1,textDecoration:vd==="discard"?"line-through":"none"}}>{v.title}</span>
                      <span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"rgba(59,130,246,0.12)",color:"#3B82F6",fontWeight:600}}>{v.type}</span>
                    </div>
                    {v.reason&&<div style={{fontSize:11,color:C.txD,marginBottom:4}}>{v.reason}</div>}
                    <VisualMockup type={v.type} chart_data={v.chart_data}/>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}>
                      <span style={{fontSize:10,color:isActive?"#3B82F6":C.txD,fontWeight:isActive?600:400}}>
                        블록 #{blockIdx}~#{(v.block_range||[])[1]||blockIdx}
                        {v.duration_seconds&&<span style={{marginLeft:8}}>⏱ {v.duration_seconds}초</span>}
                      </span>
                      <div style={{marginLeft:"auto",display:"flex",gap:3}}>
                        {[{k:"use",l:"사용",c:"#22C55E",bg:"rgba(34,197,94,0.15)"},{k:"discard",l:"폐기",c:"#EF4444",bg:"rgba(239,68,68,0.15)"}].map(o=>
                          <button key={o.k} onClick={e=>{e.stopPropagation();setVerdicts(prev=>({...prev,[vKey]:vd===o.k?null:o.k}))}}
                            style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
                              border:`1px solid ${vd===o.k?o.c:"transparent"}`,background:vd===o.k?o.bg:"rgba(255,255,255,0.04)",
                              color:vd===o.k?o.c:C.txD}}>{o.l}</button>)}
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4,marginTop:8,paddingTop:6,borderTop:`1px solid ${C.bd}44`}}>
                      <select onClick={e=>e.stopPropagation()} onChange={e=>{e.stopPropagation();handleRegenerate(v,"visuals",e.target.value||undefined);e.target.value=""}}
                        disabled={busy} value=""
                        style={{fontSize:10,padding:"4px 6px",borderRadius:5,border:`1px solid ${C.ac}44`,background:C.acS,color:C.ac,cursor:busy?"not-allowed":"pointer",fontWeight:600,flex:1,outline:"none",fontFamily:FN}}>
                        <option value="" disabled>🔄 다른 형식으로 재생성...</option>
                        {VIS_CATEGORIES.map(cat=><option key={cat.value} value={cat.value}>{cat.label}</option>)}
                      </select>
                      <button onClick={e=>{e.stopPropagation();handleRegenerate(v,"visuals")}} disabled={busy}
                        style={{fontSize:10,fontWeight:600,padding:"4px 10px",borderRadius:5,border:"none",cursor:busy?"not-allowed":"pointer",background:"rgba(59,130,246,0.7)",color:"#fff",whiteSpace:"nowrap"}}>🔄 재생성</button>
                    </div>
                  </div>;
                })}
              </>}
              {tab==="inserts" && <>
                {insertCuts.length===0&&<p style={{padding:30,textAlign:"center",fontSize:12,color:C.txD}}>🎬 전체 생성 또는 블록 드래그 → 구간 추천</p>}
                {insertCuts.map((ic,i)=>{
                  const blockIdx=(ic.block_range||[])[0];
                  const vKey=`ic-${ic.id}`; const vd=verdicts[vKey]||null;
                  return <div key={`ic-${ic.id||i}`} ref={el=>{if(el&&!cEls.current[blockIdx])cEls.current[blockIdx]=el}}
                    data-card-block={blockIdx}>
                    <InsertCutCard item={ic} active={aBlock===blockIdx} onClick={scrollTo}
                      verdict={vd} onVerdict={v=>setVerdicts(prev=>({...prev,[vKey]:vd===v?null:v}))}
                      onRegenerate={()=>handleRegenerate(ic,"inserts")} busy={busy}/></div>;
                })}
              </>}
            </div>
          </div>
        </div>
      )}
    </main>
    <style>{`
      @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
      *{box-sizing:border-box;margin:0;padding:0}
      ::-webkit-scrollbar{width:10px;height:10px}
      ::-webkit-scrollbar-track{background:rgba(255,255,255,0.03)}
      ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:5px}
      body{overflow:hidden}
    `}</style>
  </div>;
}
