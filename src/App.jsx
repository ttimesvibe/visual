import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import * as mammoth from "mammoth";
import JSZip from "jszip";

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const WORKER_URL = "https://visual.ttimes.workers.dev";
const AUTOSAVE_INTERVAL = 3 * 60 * 1000; // 3분

// 시각화 카테고리 (재생성 시 선택)
const VIS_CATEGORIES = [
  { value: "", label: "🎯 AI 자동 선택" },
  { value: "bar", label: "📊 막대 차트" },
  { value: "bar_horizontal", label: "📊 수평 막대" },
  { value: "line", label: "📈 라인 차트" },
  { value: "donut", label: "🍩 도넛/파이" },
  { value: "kpi", label: "🔢 KPI 숫자" },
  { value: "table", label: "📋 표" },
  { value: "comparison", label: "⚖️ 비교" },
  { value: "ranking", label: "🏆 랭킹" },
  { value: "process", label: "🔄 프로세스" },
  { value: "timeline", label: "📅 타임라인" },
  { value: "structure", label: "🧱 구조도" },
  { value: "cycle", label: "♻️ 순환" },
  { value: "matrix", label: "📐 매트릭스" },
  { value: "hierarchy", label: "🌳 계층도" },
  { value: "radar", label: "🕸 레이더" },
  { value: "venn", label: "⭕ 벤 다이어그램" },
  { value: "network", label: "🔗 네트워크" },
  { value: "stack", label: "📚 스택" },
  { value: "progress", label: "📏 진행률" },
  { value: "checklist", label: "☑️ 체크리스트" },
];
const C = {
  bg: "#0f1117", sf: "#1a1d27", bd: "#2a2d3a", tx: "#e4e4e7",
  txM: "#a1a1aa", txD: "#71717a", ac: "#4A6CF7", acS: "rgba(74,108,247,0.12)",
  ok: "#22C55E", wn: "#F59E0B", err: "#EF4444",
};
const FN = "'Pretendard','Noto Sans KR',-apple-system,sans-serif";
const VIS_COLORS = ["#3B82F6", "#8B5CF6", "#EF4444", "#22C55E", "#F59E0B", "#EC4899", "#06B6D4", "#F97316"];

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
// DOCX 삭제선 파싱 (w:del → w:delText)
// ═══════════════════════════════════════
async function parseDocxWithTrackChanges(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("word/document.xml을 찾을 수 없습니다");

  const bodyMatch = docXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error("문서 본문을 찾을 수 없습니다");
  const bodyXml = bodyMatch[1];

  const paragraphs = [];
  const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyXml)) !== null) {
    const pXml = pMatch[0];
    const segments = [];
    const tokenRegex = /<w:del\b[^>]*>([\s\S]*?)<\/w:del>|<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>|<w:r[ >]([\s\S]*?)<\/w:r>/g;
    let tMatch;
    while ((tMatch = tokenRegex.exec(pXml)) !== null) {
      if (tMatch[1] !== undefined) {
        // w:del block — extract w:delText
        const delTexts = tMatch[1].match(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g) || [];
        const text = delTexts.map(dt => dt.replace(/<[^>]+>/g, "")).join("");
        if (text) segments.push({ text, deleted: true });
      } else if (tMatch[2] !== undefined) {
        // w:ins block
        const insTexts = tMatch[2].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
        const text = insTexts.map(t => t.replace(/<[^>]+>/g, "")).join("");
        if (text) segments.push({ text, deleted: false });
      } else if (tMatch[3] !== undefined) {
        // normal w:r
        const texts = tMatch[3].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
        const text = texts.map(t => t.replace(/<[^>]+>/g, "")).join("");
        if (text) segments.push({ text, deleted: false });
      }
    }
    if (segments.length > 0) paragraphs.push(segments);
  }

  const hasTrackChanges = paragraphs.some(p => p.some(s => s.deleted));
  const fullText = paragraphs.map(p => p.map(s => s.text).join("")).join("\n");
  const cleanText = paragraphs.map(p => p.filter(s => !s.deleted).map(s => s.text).join("")).join("\n");

  return { hasTrackChanges, fullText, cleanText, paragraphs };
}

// ═══════════════════════════════════════
// FILE UPLOADER COMPONENT
// ═══════════════════════════════════════
function FileUploader({ onFileLoad, busy }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    onFileLoad(file);
  }, [onFileLoad]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? C.ac : C.bd}`,
        borderRadius: 16, padding: "48px 32px", textAlign: "center",
        cursor: busy ? "not-allowed" : "pointer",
        background: dragging ? C.acS : "transparent",
        transition: "all 0.2s",
      }}>
      <input ref={inputRef} type="file" accept=".docx,.txt" style={{ display: "none" }}
        onChange={e => handleFile(e.target.files[0])} />
      <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.tx, marginBottom: 6 }}>
        .docx 또는 .txt 파일을 드래그하거나 클릭하여 업로드
      </div>
      <div style={{ fontSize: 12, color: C.txD }}>
        Word 검토 모드의 삭제선(취소선)을 자동 인식합니다
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// BLOCK PARSER (ttimes-doctor 호환)
// ═══════════════════════════════════════
function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let cur = null;
  const speakerRe = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  for (const line of lines) {
    const m = line.match(speakerRe);
    if (m) {
      if (cur && cur.text.trim()) blocks.push(cur);
      cur = { index: blocks.length, speaker: m[1].trim(), timestamp: m[2], text: "" };
    } else {
      if (!cur) cur = { index: 0, speaker: "—", timestamp: "0:00", text: "" };
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  if (cur && cur.text.trim()) blocks.push(cur);
  return blocks.map((b, i) => ({ ...b, index: i }));
}

// ═══════════════════════════════════════
// VISUAL MOCKUP (21종 시각화 템플릿 렌더러)
// ═══════════════════════════════════════
function VisualMockup({ type, chart_data, title }) {
  if (!chart_data) return <div style={{ padding: 12, fontSize: 12, color: C.txD }}>데이터 없음</div>;

  const wrap = (children) => (
    <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: 14, marginTop: 8 }}>
      {title && <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, marginBottom: 10, textAlign: "center" }}>{title}</div>}
      {children}
    </div>
  );

  // ── BAR / BAR_HORIZONTAL / BAR_STACKED ──
  if (["bar", "bar_horizontal", "bar_stacked"].includes(type)) {
    const d = chart_data;
    const labels = d.labels || [];
    const datasets = d.datasets || [];
    const maxVal = Math.max(...datasets.flatMap(ds => ds.data || []), 1);
    const isH = type === "bar_horizontal";
    return wrap(
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {isH ? labels.map((lb, i) => {
          const vals = datasets.map(ds => ({ val: (ds.data || [])[i] || 0, color: (ds.colors || VIS_COLORS)[i % VIS_COLORS.length] }));
          return <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: C.txM, width: 80, textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lb}</span>
            <div style={{ flex: 1, display: "flex", gap: 2 }}>
              {vals.map((v, vi) => <div key={vi} style={{ height: 20, borderRadius: 3, background: v.color, width: `${(v.val / maxVal) * 100}%`, minWidth: 2, transition: "width 0.3s" }} />)}
            </div>
            <span style={{ fontSize: 10, color: C.txD, width: 40 }}>{vals.map(v => v.val).join("/")}{d.unit || ""}</span>
          </div>;
        }) : <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120, padding: "0 4px" }}>
          {labels.map((lb, i) => {
            const total = type === "bar_stacked"
              ? datasets.reduce((s, ds) => s + ((ds.data || [])[i] || 0), 0)
              : Math.max(...datasets.map(ds => (ds.data || [])[i] || 0));
            return <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div style={{ width: "100%", display: "flex", flexDirection: "column-reverse", height: 100 }}>
                {datasets.map((ds, di) => {
                  const val = (ds.data || [])[i] || 0;
                  const h = total > 0 ? (val / maxVal) * 100 : 0;
                  return <div key={di} style={{ width: "100%", height: `${h}%`, background: (ds.colors || VIS_COLORS)[type === "bar_stacked" ? di : i] || VIS_COLORS[i % VIS_COLORS.length], borderRadius: 2, minHeight: val > 0 ? 2 : 0 }} />;
                })}
              </div>
              <span style={{ fontSize: 9, color: C.txD, textAlign: "center", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lb}</span>
            </div>;
          })}
        </div>}
        {datasets.length > 1 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {datasets.map((ds, di) => <span key={di} style={{ fontSize: 9, color: C.txM, display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: VIS_COLORS[di] }} />{ds.label}
          </span>)}
        </div>}
      </div>
    );
  }

  // ── LINE ──
  if (type === "line") {
    const d = chart_data;
    const labels = d.labels || [];
    const datasets = d.datasets || [];
    const allVals = datasets.flatMap(ds => ds.data || []);
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const range = maxV - minV || 1;
    const W = 360, H = 100;
    return wrap(
      <div>
        <svg viewBox={`0 0 ${W} ${H + 20}`} style={{ width: "100%" }}>
          {datasets.map((ds, di) => {
            const data = ds.data || [];
            const pts = data.map((v, i) => `${(i / (data.length - 1 || 1)) * (W - 20) + 10},${H - ((v - minV) / range) * (H - 10) + 5}`).join(" ");
            return <polyline key={di} points={pts} fill="none" stroke={VIS_COLORS[di]} strokeWidth="2" />;
          })}
          {labels.map((lb, i) => <text key={i} x={(i / (labels.length - 1 || 1)) * (W - 20) + 10} y={H + 16} fill={C.txD} fontSize="8" textAnchor="middle">{lb}</text>)}
        </svg>
        {datasets.length > 1 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {datasets.map((ds, di) => <span key={di} style={{ fontSize: 9, color: C.txM, display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 8, height: 3, borderRadius: 1, background: VIS_COLORS[di] }} />{ds.label}
          </span>)}
        </div>}
      </div>
    );
  }

  // ── DONUT / PIE ──
  if (type === "donut" || type === "pie") {
    const d = chart_data;
    const labels = d.labels || [];
    const values = (d.datasets?.[0]?.data) || d.values || [];
    const total = values.reduce((s, v) => s + v, 0) || 1;
    let angle = 0;
    const R = 50, CX = 60, CY = 60;
    const slices = values.map((v, i) => {
      const pct = v / total;
      const startAngle = angle;
      angle += pct * 360;
      const endAngle = angle;
      const s1 = Math.PI / 180 * (startAngle - 90);
      const s2 = Math.PI / 180 * (endAngle - 90);
      const large = pct > 0.5 ? 1 : 0;
      return { path: `M${CX} ${CY} L${CX + R * Math.cos(s1)} ${CY + R * Math.sin(s1)} A${R} ${R} 0 ${large} 1 ${CX + R * Math.cos(s2)} ${CY + R * Math.sin(s2)} Z`, color: VIS_COLORS[i % VIS_COLORS.length], label: labels[i], pct };
    });
    return wrap(
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <svg viewBox="0 0 120 120" style={{ width: 100, height: 100, flexShrink: 0 }}>
          {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke={C.bg} strokeWidth="1" />)}
          {type === "donut" && <circle cx={CX} cy={CY} r={28} fill={C.bg} />}
        </svg>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {slices.map((s, i) => <span key={i} style={{ fontSize: 10, color: C.txM, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />{s.label} ({(s.pct * 100).toFixed(0)}%)
          </span>)}
        </div>
      </div>
    );
  }

  // ── COMPARISON ──
  if (type === "comparison") {
    const items = chart_data.items || [];
    return wrap(
      <div style={{ display: "grid", gridTemplateColumns: items.length <= 3 ? `repeat(${items.length}, 1fr)` : "repeat(2, 1fr)", gap: 8 }}>
        {items.map((item, i) => (
          <div key={i} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 10, border: `1px solid ${item.highlight ? VIS_COLORS[0] : C.bd}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: item.highlight ? VIS_COLORS[0] : C.tx, marginBottom: 6 }}>{item.name}</div>
            {(item.features || item.specs || []).map((f, fi) => (
              <div key={fi} style={{ fontSize: 10, color: C.txM, padding: "2px 0", borderBottom: `1px solid ${C.bd}22` }}>
                {typeof f === "string" ? f : `${f.label}: ${f.value}`}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  // ── TABLE ──
  if (type === "table") {
    const headers = chart_data.headers || [];
    const rows = chart_data.rows || [];
    return wrap(
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr>{headers.map((h, i) => <th key={i} style={{ padding: "4px 8px", borderBottom: `1px solid ${C.bd}`, color: C.ac, textAlign: "left", fontWeight: 600 }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => <tr key={ri}>
              {(Array.isArray(row) ? row : Object.values(row)).map((cell, ci) => <td key={ci} style={{ padding: "4px 8px", borderBottom: `1px solid ${C.bd}22`, color: C.txM }}>{cell}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
    );
  }

  // ── CHECKLIST ──
  if (type === "checklist") {
    const items = chart_data.items || [];
    return wrap(
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "3px 0" }}>
            <span style={{ fontSize: 12, flexShrink: 0 }}>{item.checked ? "✅" : "⬜"}</span>
            <span style={{ fontSize: 11, color: C.txM }}>{typeof item === "string" ? item : item.text || item.label}</span>
          </div>
        ))}
      </div>
    );
  }

  // ── RANKING ──
  if (type === "ranking") {
    const items = chart_data.items || [];
    return wrap(
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: i === 0 ? "rgba(245,158,11,0.1)" : "transparent", borderRadius: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: i < 3 ? [C.wn, "#94A3B8", "#CD7F32"][i] : C.txD, width: 24, textAlign: "center" }}>{i + 1}</span>
            <span style={{ fontSize: 11, color: C.tx, flex: 1 }}>{typeof item === "string" ? item : item.name || item.label}</span>
            {item.value != null && <span style={{ fontSize: 10, color: C.txD }}>{item.value}{item.unit || ""}</span>}
          </div>
        ))}
      </div>
    );
  }

  // ── PROCESS / TIMELINE ──
  if (type === "process" || type === "timeline") {
    const steps = chart_data.steps || chart_data.items || [];
    return wrap(
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {steps.map((step, i) => (
          <div key={i} style={{ display: "flex", gap: 10, minHeight: 40 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 20 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: VIS_COLORS[i % VIS_COLORS.length], flexShrink: 0, marginTop: 4 }} />
              {i < steps.length - 1 && <div style={{ width: 2, flex: 1, background: `${VIS_COLORS[i % VIS_COLORS.length]}44` }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.tx }}>{typeof step === "string" ? step : step.title || step.label || step.name}</div>
              {step.description && <div style={{ fontSize: 10, color: C.txD, marginTop: 2 }}>{step.description}</div>}
              {step.time && <div style={{ fontSize: 9, color: C.txD, marginTop: 1 }}>⏱ {step.time}</div>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── STRUCTURE ──
  if (type === "structure") {
    const elements = chart_data.elements || chart_data.items || [];
    const format = chart_data.format || "";
    const cols = format.includes("2x") ? 2 : format.includes("3x") ? 3 : Math.min(elements.length, 3);
    return wrap(
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
        {elements.map((el, i) => (
          <div key={i} style={{ background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 10, borderLeft: `3px solid ${VIS_COLORS[i % VIS_COLORS.length]}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.tx, marginBottom: 4 }}>{el.label || el.title || el.name}</div>
            {el.detail && <div style={{ fontSize: 10, color: C.txD }}>{el.detail}</div>}
            {el.description && <div style={{ fontSize: 10, color: C.txD }}>{el.description}</div>}
          </div>
        ))}
      </div>
    );
  }

  // ── KPI ──
  if (type === "kpi") {
    const items = chart_data.items || chart_data.metrics || [];
    return wrap(
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(items.length, 4)}, 1fr)`, gap: 8 }}>
        {items.map((item, i) => (
          <div key={i} style={{ textAlign: "center", background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: VIS_COLORS[i % VIS_COLORS.length] }}>{item.value}</div>
            <div style={{ fontSize: 10, color: C.txM, marginTop: 4 }}>{item.label || item.name}</div>
            {item.change && <div style={{ fontSize: 9, color: item.change > 0 ? C.ok : C.err, marginTop: 2 }}>{item.change > 0 ? "▲" : "▼"} {Math.abs(item.change)}%</div>}
          </div>
        ))}
      </div>
    );
  }

  // ── MATRIX ──
  if (type === "matrix") {
    const axes = chart_data.axes || {};
    const items = chart_data.items || [];
    return wrap(
      <div style={{ position: "relative", height: 160, border: `1px solid ${C.bd}` }}>
        {axes.x && <div style={{ position: "absolute", bottom: -16, left: "50%", transform: "translateX(-50%)", fontSize: 9, color: C.txD }}>{axes.x}</div>}
        {axes.y && <div style={{ position: "absolute", left: -4, top: "50%", transform: "translateY(-50%) rotate(-90deg)", fontSize: 9, color: C.txD }}>{axes.y}</div>}
        {items.map((item, i) => {
          const x = (item.x ?? 50) + "%";
          const y = (100 - (item.y ?? 50)) + "%";
          return <div key={i} style={{ position: "absolute", left: x, top: y, transform: "translate(-50%,-50%)", background: VIS_COLORS[i % VIS_COLORS.length], borderRadius: "50%", width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff", fontWeight: 700 }} title={item.label}>{(item.label || "")[0]}</div>;
        })}
      </div>
    );
  }

  // ── STACK ──
  if (type === "stack") {
    const layers = chart_data.layers || chart_data.items || [];
    return wrap(
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {layers.map((layer, i) => (
          <div key={i} style={{ background: `${VIS_COLORS[i % VIS_COLORS.length]}22`, borderLeft: `3px solid ${VIS_COLORS[i % VIS_COLORS.length]}`, padding: "6px 10px", borderRadius: "0 6px 6px 0" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: C.tx }}>{typeof layer === "string" ? layer : layer.label || layer.name}</span>
            {layer.description && <span style={{ fontSize: 10, color: C.txD, marginLeft: 8 }}>{layer.description}</span>}
          </div>
        ))}
      </div>
    );
  }

  // ── CYCLE ──
  if (type === "cycle") {
    const steps = chart_data.steps || chart_data.items || [];
    const n = steps.length;
    const R = 50, CX = 60, CY = 60;
    return wrap(
      <svg viewBox="0 0 120 120" style={{ width: 160, height: 160, display: "block", margin: "0 auto" }}>
        {steps.map((step, i) => {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          const x = CX + R * Math.cos(angle);
          const y = CY + R * Math.sin(angle);
          return <g key={i}>
            <circle cx={x} cy={y} r={12} fill={VIS_COLORS[i % VIS_COLORS.length]} />
            <text x={x} y={y + 3} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">{i + 1}</text>
            <text x={x} y={y + 18} textAnchor="middle" fill={C.txM} fontSize="6">{typeof step === "string" ? step : step.label || step.name}</text>
          </g>;
        })}
      </svg>
    );
  }

  // ── RADAR ──
  if (type === "radar") {
    const labels = chart_data.labels || [];
    const values = (chart_data.datasets?.[0]?.data) || chart_data.values || [];
    const n = labels.length;
    const R = 45, CX = 60, CY = 60;
    const maxV = Math.max(...values, 1);
    const pts = values.map((v, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      return `${CX + (v / maxV) * R * Math.cos(angle)},${CY + (v / maxV) * R * Math.sin(angle)}`;
    }).join(" ");
    return wrap(
      <svg viewBox="0 0 120 120" style={{ width: 160, height: 160, display: "block", margin: "0 auto" }}>
        {[0.25, 0.5, 0.75, 1].map(s => <polygon key={s} points={labels.map((_, i) => {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          return `${CX + s * R * Math.cos(angle)},${CY + s * R * Math.sin(angle)}`;
        }).join(" ")} fill="none" stroke={C.bd} strokeWidth="0.5" />)}
        <polygon points={pts} fill={`${VIS_COLORS[0]}33`} stroke={VIS_COLORS[0]} strokeWidth="1.5" />
        {labels.map((lb, i) => {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          return <text key={i} x={CX + (R + 12) * Math.cos(angle)} y={CY + (R + 12) * Math.sin(angle) + 3} textAnchor="middle" fill={C.txM} fontSize="6">{lb}</text>;
        })}
      </svg>
    );
  }

  // ── VENN ──
  if (type === "venn") {
    const sets = chart_data.sets || chart_data.items || [];
    return wrap(
      <svg viewBox="0 0 160 100" style={{ width: "100%", height: 100 }}>
        {sets.slice(0, 3).map((s, i) => {
          const cx = [50, 110, 80][i] || 80;
          const cy = [50, 50, 70][i] || 50;
          return <g key={i}>
            <circle cx={cx} cy={cy} r={35} fill={`${VIS_COLORS[i]}22`} stroke={VIS_COLORS[i]} strokeWidth="1" />
            <text x={cx} y={cy + 3} textAnchor="middle" fill={C.txM} fontSize="8">{typeof s === "string" ? s : s.label || s.name}</text>
          </g>;
        })}
        {chart_data.intersection && <text x="80" y="55" textAnchor="middle" fill={C.tx} fontSize="7" fontWeight="700">{chart_data.intersection}</text>}
      </svg>
    );
  }

  // ── NETWORK ──
  if (type === "network") {
    const nodes = chart_data.nodes || [];
    const edges = chart_data.edges || chart_data.links || [];
    const W = 200, H = 120;
    return wrap(
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 120 }}>
        {edges.map((e, i) => {
          const src = nodes.find(n => n.id === e.source || n.name === e.source) || nodes[0];
          const tgt = nodes.find(n => n.id === e.target || n.name === e.target) || nodes[1];
          if (!src || !tgt) return null;
          return <line key={i} x1={src.x || 30} y1={src.y || 30} x2={tgt.x || 100} y2={tgt.y || 60} stroke={C.bd} strokeWidth="1" />;
        })}
        {nodes.map((n, i) => (
          <g key={i}>
            <circle cx={n.x || (30 + i * 40)} cy={n.y || (30 + (i % 2) * 40)} r={14} fill={VIS_COLORS[i % VIS_COLORS.length]} />
            <text x={n.x || (30 + i * 40)} y={(n.y || (30 + (i % 2) * 40)) + 3} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="600">{(n.label || n.name || "")[0]}</text>
            <text x={n.x || (30 + i * 40)} y={(n.y || (30 + (i % 2) * 40)) + 22} textAnchor="middle" fill={C.txM} fontSize="6">{n.label || n.name}</text>
          </g>
        ))}
      </svg>
    );
  }

  // ── HIERARCHY ──
  if (type === "hierarchy") {
    const root = chart_data.root || chart_data;
    const renderNode = (node, depth = 0) => (
      <div key={node.label || node.name} style={{ marginLeft: depth * 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
          {depth > 0 && <span style={{ color: C.bd }}>└</span>}
          <span style={{ fontSize: 11, fontWeight: depth === 0 ? 700 : 400, color: depth === 0 ? C.ac : C.txM }}>{node.label || node.name}</span>
        </div>
        {(node.children || []).map(child => renderNode(child, depth + 1))}
      </div>
    );
    return wrap(renderNode(root));
  }

  // ── PROGRESS ──
  if (type === "progress") {
    const items = chart_data.items || chart_data.metrics || [];
    return wrap(
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item, i) => {
          const pct = item.value != null ? item.value : item.percent || 0;
          return <div key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: C.tx }}>{item.label || item.name}</span>
              <span style={{ fontSize: 10, color: C.txD }}>{pct}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)" }}>
              <div style={{ height: "100%", borderRadius: 3, background: VIS_COLORS[i % VIS_COLORS.length], width: `${Math.min(pct, 100)}%`, transition: "width 0.3s" }} />
            </div>
          </div>;
        })}
      </div>
    );
  }

  // ── FALLBACK ──
  return wrap(
    <div style={{ padding: 10, fontSize: 11, color: C.txD, textAlign: "center" }}>
      <div style={{ marginBottom: 4 }}>📊 {type}</div>
      <pre style={{ fontSize: 9, color: C.txD, textAlign: "left", whiteSpace: "pre-wrap", maxHeight: 100, overflow: "auto" }}>
        {JSON.stringify(chart_data, null, 2)}
      </pre>
    </div>
  );
}

// ═══════════════════════════════════════
// INSERT CUT CARD
// ═══════════════════════════════════════
function InsertCutCard({ item, active, onClick, verdict, onVerdict, onRegenerate, busy }) {
  const blockIdx = (item.block_range || [])[0];
  const typeLabel = { A: "🎨 일러스트", B: "🔍 공식 자료", C: "📸 성과물" }[item.type] || item.type;
  const isDiscarded = verdict === "discard";

  return (
    <div onClick={() => onClick?.(blockIdx)} style={{
      padding: 12, borderRadius: 10, cursor: "pointer",
      border: `1px solid ${active ? "#F59E0B" : verdict === "use" ? C.ok : C.bd}`,
      background: active ? "rgba(245,158,11,0.06)" : isDiscarded ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.15)",
      opacity: isDiscarded ? 0.5 : 1, marginBottom: 8, transition: "all 0.15s",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(245,158,11,0.12)", color: "#F59E0B" }}>{typeLabel}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.tx, flex: 1, textDecoration: isDiscarded ? "line-through" : "none" }}>{item.title}</span>
      </div>
      {/* Reason */}
      {item.reason && <div style={{ fontSize: 10, color: C.txD, marginBottom: 6 }}>{item.reason}</div>}
      {/* Editor instruction */}
      {item.editor_instruction && <div style={{ fontSize: 10, color: C.txM, padding: "4px 8px", background: "rgba(255,255,255,0.03)", borderRadius: 6, marginBottom: 6 }}>{item.editor_instruction}</div>}
      {/* Type-specific content */}
      {item.type === "A" && item.image_prompt && (
        <div style={{ fontSize: 10, color: "#A855F7", padding: "4px 8px", background: "rgba(168,85,247,0.08)", borderRadius: 6, marginBottom: 6, cursor: "pointer" }}
          onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(item.image_prompt); }}>
          🖼 {item.image_prompt.substring(0, 80)}... <span style={{ color: C.txD }}>(클릭→복사)</span>
        </div>
      )}
      {item.type === "B" && (item.search_keywords || item.youtube_keywords) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {(item.search_keywords || item.youtube_keywords || []).map((kw, i) => (
            <span key={i} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "rgba(59,130,246,0.1)", color: "#3B82F6" }}>{kw}</span>
          ))}
        </div>
      )}
      {/* Block info */}
      <div style={{ fontSize: 10, color: active ? "#F59E0B" : C.txD, marginTop: 4, fontWeight: active ? 600 : 400 }}>
        블록 #{blockIdx}~#{(item.block_range || [])[1] || blockIdx}
        {item.duration_seconds && <span style={{ marginLeft: 8 }}>⏱ {item.duration_seconds}초</span>}
      </div>
      {/* Regenerate + Verdict row */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.bd}44` }}>
        <button onClick={e => { e.stopPropagation(); onRegenerate?.(); }} disabled={busy}
          style={{ fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 5, border: "none", cursor: busy ? "not-allowed" : "pointer", background: "rgba(245,158,11,0.7)", color: "#fff", whiteSpace: "nowrap" }}>🔄 재생성</button>
        <div style={{ flex: 1 }} />
        {[{ k: "use", l: "사용", c: C.ok, bg: "rgba(34,197,94,0.15)" }, { k: "discard", l: "폐기", c: C.err, bg: "rgba(239,68,68,0.15)" }].map(o =>
          <button key={o.k} onClick={e => { e.stopPropagation(); onVerdict?.(o.k); }}
            style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, cursor: "pointer", transition: "all 0.1s", border: `1px solid ${verdict === o.k ? o.c : "transparent"}`, background: verdict === o.k ? o.bg : "rgba(255,255,255,0.04)", color: verdict === o.k ? o.c : C.txD }}>{o.l}</button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// MAIN APP
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
  const [fn, setFn] = useState("");
  const [paragraphs, setParagraphs] = useState(null); // docx track-changes [{text, deleted}][]

  // Text selection state
  const [textSel, setTextSel] = useState(null); // { text, blockIndices }
  const clearTextSel = useCallback(() => setTextSel(null), []);

  const lRef = useRef(null);
  const rRef = useRef(null);
  const bEls = useRef({});
  const cEls = useRef({});

  // ── Scroll sync ──
  const scrollTo = useCallback((blockIdx) => {
    setABlock(blockIdx);
    const bEl = bEls.current[blockIdx];
    const cEl = cEls.current[blockIdx];
    if (bEl && lRef.current) {
      lRef.current.scrollTo({ top: bEl.offsetTop - lRef.current.offsetTop - 40, behavior: "smooth" });
    }
    if (cEl && rRef.current) {
      rRef.current.scrollTo({ top: cEl.offsetTop - rRef.current.offsetTop - 40, behavior: "smooth" });
    }
  }, []);

  // ── Text selection handler ──
  const handleTextSelect = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (text.length < 10) return;

    // Find which blocks the selection spans
    const range = selection.getRangeAt(0);
    const container = lRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) return;

    const blockIndices = [];
    for (const [idx, el] of Object.entries(bEls.current)) {
      if (el && range.intersectsNode(el)) blockIndices.push(parseInt(idx));
    }
    if (blockIndices.length === 0) return;
    blockIndices.sort((a, b) => a - b);
    setTextSel({ text, blockIndices });
  }, []);

  // ── File upload handler ──
  const onFileUpload = useCallback(async (file) => {
    if (!file) return;
    setErr(null);
    setProg("📄 파일 읽는 중...");

    try {
      if (file.name.endsWith(".docx")) {
        const buf = await file.arrayBuffer();
        // Try track-changes parsing first
        try {
          const tcResult = await parseDocxWithTrackChanges(buf.slice(0));
          if (tcResult.hasTrackChanges) {
            setParagraphs(tcResult.paragraphs);
            const parsed = parseBlocks(tcResult.cleanText);
            if (parsed.length === 0) { setErr("블록을 파싱할 수 없습니다."); setProg(""); return; }
            setBlocks(parsed);
            setInputText(tcResult.cleanText);
            setFn(file.name);
            setLoaded(true);
            setVisualGuides([]); setInsertCuts([]); setVerdicts({});
            setProg(`✅ ${file.name} — 삭제선 감지됨 (${parsed.length}블록)`);
            return;
          }
        } catch (e) {
          console.warn("삭제선 파싱 실패, mammoth fallback:", e.message);
        }
        // No track changes — use mammoth
        const res = await mammoth.extractRawText({ arrayBuffer: buf });
        const parsed = parseBlocks(res.value);
        if (parsed.length === 0) { setErr("블록을 파싱할 수 없습니다."); setProg(""); return; }
        setBlocks(parsed);
        setInputText(res.value);
        setFn(file.name);
        setParagraphs(null);
        setLoaded(true);
        setVisualGuides([]); setInsertCuts([]); setVerdicts({});
        setProg(`✅ ${file.name} — ${parsed.length}블록`);
      } else {
        // txt file
        const text = await file.text();
        const parsed = parseBlocks(text);
        if (parsed.length === 0) { setErr("블록을 파싱할 수 없습니다."); setProg(""); return; }
        setBlocks(parsed);
        setInputText(text);
        setFn(file.name);
        setParagraphs(null);
        setLoaded(true);
        setVisualGuides([]); setInsertCuts([]); setVerdicts({});
        setProg(`✅ ${file.name} — ${parsed.length}블록`);
      }
    } catch (e) {
      setErr(`파일 처리 실패: ${e.message}`);
      setProg("");
    }
  }, []);

  // ── Text input fallback ──
  const handleLoad = useCallback(() => {
    const parsed = parseBlocks(inputText);
    if (parsed.length === 0) { setErr("블록을 파싱할 수 없습니다."); return; }
    setBlocks(parsed);
    setLoaded(true);
    setErr(null);
    setFn("");
    setParagraphs(null);
    setVisualGuides([]);
    setInsertCuts([]);
    setVerdicts({});
  }, [inputText]);

  // ── Full generate ──
  const handleGenerate = useCallback(async (mode) => {
    if (blocks.length === 0) return;
    setBusy(true); setErr(null);
    const endpoint = mode === "visuals" ? "/visuals" : "/insert-cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
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
        const items = d.result?.[key] || [];
        all.push(...items);
        if (ci < chunks.length - 1) { setProg("청크 간 대기 중... ☕"); await delay(3000); }
      }
      all = all.map((v, i) => ({ ...v, id: Date.now() + i }));
      // v1.9: 누적 (덮어쓰기 아님)
      if (mode === "visuals") { setVisualGuides(prev => [...prev, ...all]); setTab("visuals"); }
      else { setInsertCuts(prev => [...prev, ...all]); setTab("inserts"); }
      setProg(`✅ ${label} 완료 (${all.length}건 추가)`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [blocks]);

  // ── Text selection generate ──
  const handleSelectionGenerate = useCallback(async (mode) => {
    if (!textSel || blocks.length === 0) return;
    setBusy(true); setErr(null);
    const rangeBlocks = blocks.filter(b => textSel.blockIndices.includes(b.index));
    if (rangeBlocks.length === 0) { setBusy(false); return; }
    const endpoint = mode === "visuals" ? "/visuals" : "/insert-cuts";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    try {
      const blockLabel = textSel.blockIndices.length === 1
        ? `블록 #${textSel.blockIndices[0]}`
        : `블록 #${textSel.blockIndices[0]}~#${textSel.blockIndices[textSel.blockIndices.length - 1]}`;
      setProg(`${label} 생성 중 (${blockLabel}, 선택 ${textSel.text.length}자)...`);
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

  // ── Per-card regenerate (with optional category) ──
  const handleRegenerate = useCallback(async (item, mode, preferredType) => {
    setBusy(true); setErr(null);
    const range = item.block_range || [0, 0];
    const rangeBlocks = blocks.filter(b => b.index >= range[0] && b.index <= (range[1] || range[0]));
    if (rangeBlocks.length === 0) { setBusy(false); return; }
    const endpoint = mode === "visuals" ? "/visuals" : "/insert-cuts";
    const key = mode === "visuals" ? "visual_guides" : "insert_cuts";
    const label = mode === "visuals" ? "📊 시각화" : "🎬 인서트 컷";
    try {
      const typeLabel = preferredType ? ` (${preferredType})` : "";
      setProg(`🔄 ${label} 재생성 중${typeLabel} (블록 #${range[0]}~#${range[1] || range[0]})...`);
      const payload = { blocks: rangeBlocks };
      if (preferredType) payload.preferred_type = preferredType;
      const d = await apiCall(endpoint, payload);
      const newItems = (d.result?.[key] || []).map((v, i) => ({ ...v, id: Date.now() + i }));
      if (newItems.length === 0) { setProg("⚠ 재생성 결과 없음"); setBusy(false); return; }
      const vKey = mode === "visuals" ? `vis-${item.id}` : `ic-${item.id}`;
      if (mode === "visuals") {
        setVisualGuides(prev => {
          const idx = prev.findIndex(v => v.id === item.id);
          if (idx === -1) return [...prev, ...newItems];
          const next = [...prev]; next.splice(idx, 1, ...newItems); return next;
        });
      } else {
        setInsertCuts(prev => {
          const idx = prev.findIndex(v => v.id === item.id);
          if (idx === -1) return [...prev, ...newItems];
          const next = [...prev]; next.splice(idx, 1, ...newItems); return next;
        });
      }
      setVerdicts(prev => { const n = { ...prev }; delete n[vKey]; return n; });
      setProg(`✅ ${label} 재생성 완료 (${newItems.length}건)`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [blocks]);

  // ── Clear all ──
  const handleClear = useCallback(() => {
    setVisualGuides([]); setInsertCuts([]); setVerdicts({}); setProg("");
  }, []);

  // ═══════════════════════════════════════
  // SESSION / AUTOSAVE
  // ═══════════════════════════════════════
  const [sessionId, setSessionId] = useState(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState(""); // "" | "pending" | "saving" | "saved"
  const autoSaveTimer = useRef(null);
  const lastSavedRef = useRef(null);

  // Gather current state for saving
  const gatherState = useCallback(() => ({
    blocks, visualGuides, insertCuts, verdicts, inputText,
  }), [blocks, visualGuides, insertCuts, verdicts, inputText]);

  // Save to KV
  const saveToKV = useCallback(async (isAuto = false) => {
    const state = gatherState();
    if (!state.blocks || state.blocks.length === 0) return;
    const stateJson = JSON.stringify(state);
    if (stateJson === lastSavedRef.current) return; // no change
    try {
      if (!isAuto) setProg("💾 저장 중...");
      setAutoSaveStatus("saving");
      const payload = { ...state };
      if (sessionId) payload.id = sessionId;
      const r = await apiCall("/save", payload);
      if (r.id && !sessionId) setSessionId(r.id);
      lastSavedRef.current = stateJson;
      setAutoSaveStatus("saved");
      if (!isAuto) setProg("✅ 저장 완료");
      setTimeout(() => setAutoSaveStatus(""), 5000);
    } catch (e) {
      setAutoSaveStatus("");
      if (!isAuto) setErr(`저장 실패: ${e.message}`);
    }
  }, [gatherState, sessionId]);

  // Autosave timer: reset on state change
  useEffect(() => {
    if (!loaded || blocks.length === 0) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    setAutoSaveStatus("pending");
    autoSaveTimer.current = setTimeout(() => {
      saveToKV(true);
    }, AUTOSAVE_INTERVAL);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [visualGuides, insertCuts, verdicts, loaded]);

  // Share URL
  const handleShare = useCallback(async () => {
    await saveToKV(false);
    const id = sessionId;
    if (id) {
      const url = `${window.location.origin}${window.location.pathname}?s=${id}`;
      navigator.clipboard.writeText(url);
      setProg(`🔗 공유 URL 복사됨: ${url}`);
    }
  }, [saveToKV, sessionId]);

  // Load from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("s");
    if (!sid) return;
    (async () => {
      try {
        setProg("📥 세션 불러오는 중...");
        const r = await fetch(`${WORKER_URL}/load/${sid}`);
        const d = await r.json();
        if (d.error) { setErr(d.error); return; }
        if (d.blocks) { setBlocks(d.blocks); setLoaded(true); }
        if (d.inputText) setInputText(d.inputText);
        if (d.visualGuides) setVisualGuides(d.visualGuides);
        if (d.insertCuts) setInsertCuts(d.insertCuts);
        if (d.verdicts) setVerdicts(d.verdicts);
        setSessionId(sid);
        lastSavedRef.current = JSON.stringify(d);
        setProg("✅ 세션 불러옴");
      } catch (e) { setErr(`세션 로드 실패: ${e.message}`); }
    })();
  }, []);

  // ── Inline cards for left panel ──
  const inlineCards = useMemo(() => {
    const map = {};
    visualGuides.forEach(v => {
      const vKey = `vis-${v.id}`;
      if (verdicts[vKey] === "use") {
        const idx = (v.block_range || [])[0];
        if (idx != null) { if (!map[idx]) map[idx] = []; map[idx].push({ type: "visual", data: v }); }
      }
    });
    insertCuts.forEach(ic => {
      const vKey = `ic-${ic.id}`;
      if (verdicts[vKey] === "use") {
        const idx = (ic.block_range || [])[0];
        if (idx != null) { if (!map[idx]) map[idx] = []; map[idx].push({ type: "insert", data: ic }); }
      }
    });
    return map;
  }, [visualGuides, insertCuts, verdicts]);

  // ═══════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════

  // ── Input screen ──
  if (!loaded) {
    return <div style={{ height: "100vh", background: C.bg, color: C.tx, fontFamily: FN, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 600, maxWidth: "90%" }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}><span style={{ color: C.ac }}>V</span>isual Guide</h1>
        <p style={{ fontSize: 13, color: C.txM, marginBottom: 16 }}>교정본 파일을 업로드하여 시각화 & 인서트 컷 가이드를 생성하세요</p>
        <FileUploader onFileLoad={onFileUpload} busy={busy} />
        <div style={{ margin: "16px 0", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, height: 1, background: C.bd }} />
          <span style={{ fontSize: 11, color: C.txD }}>또는 텍스트 직접 입력</span>
          <div style={{ flex: 1, height: 1, background: C.bd }} />
        </div>
        <textarea value={inputText} onChange={e => setInputText(e.target.value)}
          placeholder={"홍재의 00:01\n안녕하세요...\n\n게스트 00:15\n네 반갑습니다..."}
          style={{ width: "100%", height: 150, padding: 12, borderRadius: 10, border: `1px solid ${C.bd}`, background: C.sf, color: C.tx, fontSize: 13, fontFamily: FN, resize: "vertical", outline: "none" }} />
        <button onClick={handleLoad} disabled={!inputText.trim()}
          style={{ marginTop: 8, width: "100%", padding: "10px", borderRadius: 8, border: "none", background: inputText.trim() ? C.ac : C.bd, color: inputText.trim() ? "#fff" : C.txD, fontSize: 13, fontWeight: 600, cursor: inputText.trim() ? "pointer" : "not-allowed" }}>
          텍스트로 시작
        </button>
        {err && <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.15)", color: C.err, fontSize: 13 }}>⚠️ {err}</div>}
      </div>
    </div>;
  }

  // ── Main screen ──
  return <div style={{ height: "100vh", background: C.bg, color: C.tx, fontFamily: FN, display: "flex", flexDirection: "column" }}>
    {/* Header */}
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 52, borderBottom: `1px solid ${C.bd}`, background: C.sf, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 800 }}><span style={{ color: C.ac }}>V</span>isual Guide</span>
        <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, fontWeight: 600, background: "rgba(34,197,94,0.15)", color: C.ok }}>v2.1</span>
      </div>
      {/* Tab selector */}
      <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: 2 }}>
        {[["visuals", "📊 시각화"], ["inserts", "🎬 인서트 컷"]].map(([id, l]) =>
          <button key={id} onClick={() => setTab(id)} style={{ padding: "5px 14px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 12, fontWeight: tab === id ? 600 : 400, background: tab === id ? C.ac : "transparent", color: tab === id ? "#fff" : C.txD }}>{l}
            {id === "visuals" && visualGuides.length > 0 && <span style={{ marginLeft: 4, fontSize: 10 }}>({visualGuides.length})</span>}
            {id === "inserts" && insertCuts.length > 0 && <span style={{ marginLeft: 4, fontSize: 10 }}>({insertCuts.length})</span>}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {autoSaveStatus && <span style={{ fontSize: 10, color: autoSaveStatus === "saved" ? C.ok : autoSaveStatus === "saving" ? C.ac : C.txD }}>
          {autoSaveStatus === "pending" ? "⏳ 자동저장 대기" : autoSaveStatus === "saving" ? "💾 저장 중..." : "✓ 저장됨"}
        </span>}
        <button onClick={handleShare} disabled={busy || blocks.length === 0} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 5, border: `1px solid ${C.ac}44`, background: C.acS, color: C.ac, cursor: "pointer", fontWeight: 600 }}>
          {sessionId ? "↑ 업데이트" : "🔗 공유"}
        </button>
        {(visualGuides.length > 0 || insertCuts.length > 0) && <button onClick={handleClear} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 5, border: `1px solid ${C.bd}`, background: "transparent", color: C.txD, cursor: "pointer" }}>🗑 초기화</button>}
        <button onClick={() => { setLoaded(false); setBlocks([]); setFn(""); setParagraphs(null); handleClear(); }} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 5, border: `1px solid ${C.bd}`, background: "transparent", color: C.txD, cursor: "pointer" }}>← 다시 입력</button>
      </div>
    </header>

    {/* Progress / Error bar */}
    {(prog || err) && <div style={{ padding: "6px 20px", fontSize: 12, background: err ? "rgba(239,68,68,0.1)" : "rgba(74,108,247,0.08)", color: err ? C.err : C.ac, borderBottom: `1px solid ${C.bd}` }}>
      {err ? `⚠️ ${err}` : prog}
    </div>}

    {/* Main content */}
    <main style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Left panel: blocks */}
      <div ref={lRef} onMouseUp={handleTextSelect} style={{ flex: 1, overflowY: "auto", borderRight: `1px solid ${C.bd}` }}>
        <div style={{ padding: "8px 16px", fontSize: 11, fontWeight: 700, color: C.txD, textTransform: "uppercase", letterSpacing: "0.08em", borderBottom: `1px solid ${C.bd}`, position: "sticky", top: 0, background: C.bg, zIndex: 2 }}>
          {fn && <span style={{ color: C.txM, fontWeight: 400, textTransform: "none" }}>📄 {fn} · </span>}
          {paragraphs ? <span style={{ color: "#EF4444" }}>삭제선 감지 · </span> : null}
          {blocks.length}블록 · 텍스트 드래그로 구간 선택
        </div>
        {blocks.map((b, i) => {
          const isActive = aBlock === b.index;
          const hasCard = (tab === "visuals" ? visualGuides : insertCuts).some(c => (c.block_range || [])[0] === b.index);
          return <div key={i}>
            <div ref={el => { if (el) bEls.current[b.index] = el; }} data-block-idx={b.index}
              onClick={() => scrollTo(b.index)}
              style={{ padding: "8px 16px", cursor: "pointer", transition: "background 0.15s", borderLeft: `3px solid ${isActive ? C.ac : "transparent"}`, background: isActive ? C.acS : "transparent" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: isActive ? "#A855F7" : C.txD, fontFamily: "monospace", background: isActive ? "rgba(168,85,247,0.15)" : "rgba(255,255,255,0.06)", padding: "1px 5px", borderRadius: 3 }}>#{b.index}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: isActive ? C.ac : C.txM }}>{b.speaker}</span>
                <span style={{ fontSize: 11, color: C.txD, fontFamily: "monospace" }}>{b.timestamp}</span>
                {hasCard && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: tab === "visuals" ? "rgba(59,130,246,0.12)" : "rgba(245,158,11,0.12)", color: tab === "visuals" ? "#3B82F6" : "#F59E0B" }}>
                  {tab === "visuals" ? "📊" : "🎬"}
                </span>}
              </div>
              <div style={{ fontSize: 13, color: C.tx, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{b.text}</div>
            </div>
            {/* Inline "사용" cards */}
            {(inlineCards[b.index] || []).map((card, ci) => (
              <div key={ci} style={{ margin: "4px 16px 4px 20px", padding: 8, borderRadius: 8, border: `1px solid ${card.type === "visual" ? "#3B82F644" : "#F59E0B44"}`, background: card.type === "visual" ? "rgba(59,130,246,0.06)" : "rgba(245,158,11,0.06)" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: card.type === "visual" ? "#3B82F6" : "#F59E0B", marginBottom: 4 }}>
                  {card.type === "visual" ? "📊" : "🎬"} {card.data.title}
                </div>
                {card.type === "visual" && <VisualMockup type={card.data.type} chart_data={card.data.chart_data} />}
                {card.type === "insert" && card.data.editor_instruction && <div style={{ fontSize: 10, color: C.txM }}>{card.data.editor_instruction}</div>}
              </div>
            ))}
          </div>;
        })}
      </div>

      {/* Right panel: results */}
      <div ref={rRef} style={{ width: 440, minWidth: 440, overflowY: "auto", background: "rgba(0,0,0,0.12)" }}>
        {/* Generate buttons */}
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.bd}`, position: "sticky", top: 0, background: C.sf, zIndex: 2 }}>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => handleGenerate("visuals")} disabled={busy}
              style={{ flex: 1, fontSize: 11, fontWeight: 600, padding: "8px 10px", borderRadius: 6, border: "none", cursor: busy ? "not-allowed" : "pointer", background: busy ? "rgba(59,130,246,0.3)" : "rgba(59,130,246,0.8)", color: "#fff" }}>
              {busy && tab === "visuals" ? "생성 중..." : visualGuides.length > 0 ? `📊 시각화 추가 생성` : "📊 시각화 가이드 생성"}
            </button>
            <button onClick={() => handleGenerate("inserts")} disabled={busy}
              style={{ flex: 1, fontSize: 11, fontWeight: 600, padding: "8px 10px", borderRadius: 6, border: "none", cursor: busy ? "not-allowed" : "pointer", background: busy ? "rgba(245,158,11,0.3)" : "rgba(245,158,11,0.8)", color: "#fff" }}>
              {busy && tab === "inserts" ? "생성 중..." : insertCuts.length > 0 ? `🎬 인서트 추가 생성` : "🎬 인서트 컷 생성"}
            </button>
          </div>
        </div>

        {/* Cards */}
        <div style={{ padding: "8px 14px" }}>
          {tab === "visuals" && <>
            {visualGuides.length === 0 && <p style={{ padding: 30, textAlign: "center", fontSize: 12, color: C.txD }}>📊 시각화 생성 버튼을 눌러주세요</p>}
            {visualGuides.map((v, i) => {
              const blockIdx = (v.block_range || [])[0];
              const vKey = `vis-${v.id}`;
              const vd = verdicts[vKey];
              const isActive = aBlock === blockIdx;
              return <div key={v.id || i}
                ref={el => { if (el && blockIdx != null) cEls.current[blockIdx] = el; }}
                data-card-block={blockIdx}
                onClick={() => scrollTo(blockIdx)}
                style={{
                  padding: 12, borderRadius: 10, cursor: "pointer", marginBottom: 8,
                  border: `1px solid ${isActive ? "#3B82F6" : vd === "use" ? C.ok : C.bd}`,
                  background: isActive ? "rgba(59,130,246,0.06)" : vd === "discard" ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.15)",
                  opacity: vd === "discard" ? 0.5 : 1, transition: "all 0.15s",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 13 }}>📊</span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: `${v.priority === "high" ? "#EF4444" : v.priority === "medium" ? "#F59E0B" : "#94A3B8"}22`, color: v.priority === "high" ? "#EF4444" : v.priority === "medium" ? "#F59E0B" : "#94A3B8", textTransform: "uppercase" }}>{v.priority}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: C.tx, flex: 1, textDecoration: vd === "discard" ? "line-through" : "none" }}>{v.title}</span>
                  <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(59,130,246,0.12)", color: "#3B82F6", fontWeight: 600 }}>{v.type}</span>
                </div>
                {v.reason && <div style={{ fontSize: 10, color: C.txD, marginBottom: 4 }}>{v.reason}</div>}
                <VisualMockup type={v.type} chart_data={v.chart_data} title={v.chart_data?.title} />
                <div style={{ fontSize: 10, color: isActive ? "#3B82F6" : C.txD, marginTop: 6, fontWeight: isActive ? 600 : 400 }}>
                  블록 #{blockIdx}~#{(v.block_range || [])[1] || blockIdx}
                  {v.duration_seconds && <span style={{ marginLeft: 8 }}>⏱ {v.duration_seconds}초</span>}
                </div>
                {/* Regenerate row with category */}
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8, padding: "6px 0", borderTop: `1px solid ${C.bd}44` }}>
                  <select onClick={e => e.stopPropagation()} onChange={e => { e.stopPropagation(); handleRegenerate(v, "visuals", e.target.value || undefined); e.target.value = ""; }}
                    disabled={busy} value=""
                    style={{ fontSize: 10, padding: "4px 6px", borderRadius: 5, border: `1px solid ${C.ac}44`, background: C.acS, color: C.ac, cursor: busy ? "not-allowed" : "pointer", fontWeight: 600, flex: 1, outline: "none", fontFamily: FN }}>
                    <option value="" disabled>🔄 다른 형식으로 재생성...</option>
                    {VIS_CATEGORIES.map(cat => <option key={cat.value} value={cat.value}>{cat.label}</option>)}
                  </select>
                  <button onClick={e => { e.stopPropagation(); handleRegenerate(v, "visuals"); }} disabled={busy}
                    style={{ fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 5, border: "none", cursor: busy ? "not-allowed" : "pointer", background: "rgba(59,130,246,0.7)", color: "#fff", whiteSpace: "nowrap" }}>🔄 재생성</button>
                </div>
                {/* Verdict buttons */}
                <div style={{ display: "flex", gap: 3, marginTop: 6, justifyContent: "flex-end" }}>
                  {[{ k: "use", l: "사용", c: C.ok, bg: "rgba(34,197,94,0.15)" }, { k: "discard", l: "폐기", c: C.err, bg: "rgba(239,68,68,0.15)" }].map(o =>
                    <button key={o.k} onClick={e => { e.stopPropagation(); setVerdicts(prev => ({ ...prev, [vKey]: vd === o.k ? null : o.k })); }}
                      style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, cursor: "pointer", transition: "all 0.1s", border: `1px solid ${vd === o.k ? o.c : "transparent"}`, background: vd === o.k ? o.bg : "rgba(255,255,255,0.04)", color: vd === o.k ? o.c : C.txD }}>{o.l}</button>
                  )}
                </div>
              </div>;
            })}
          </>}

          {tab === "inserts" && <>
            {insertCuts.length === 0 && <p style={{ padding: 30, textAlign: "center", fontSize: 12, color: C.txD }}>🎬 인서트 컷 생성 버튼을 눌러주세요</p>}
            {insertCuts.map((ic, i) => {
              const blockIdx = (ic.block_range || [])[0];
              const vKey = `ic-${ic.id}`;
              const vd = verdicts[vKey];
              return <div key={ic.id || i}
                ref={el => { if (el && blockIdx != null) cEls.current[blockIdx] = el; }}
                data-card-block={blockIdx}>
                <InsertCutCard item={ic} active={aBlock === blockIdx} onClick={scrollTo}
                  verdict={vd} onVerdict={v => setVerdicts(prev => ({ ...prev, [vKey]: vd === v ? null : v }))}
                  onRegenerate={() => handleRegenerate(ic, "inserts")} busy={busy} />
              </div>;
            })}
          </>}
        </div>
      </div>
    </main>

    {/* Text selection floating bar */}
    {textSel && (
      <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 12, background: C.sf, border: `1px solid ${C.ac}`, boxShadow: "0 8px 32px rgba(0,0,0,0.4)", zIndex: 100 }}>
        <span style={{ fontSize: 11, color: C.txM, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          "{textSel.text.substring(0, 40)}..." ({textSel.text.length}자, {textSel.blockIndices.length}블록)
        </span>
        <button onClick={() => handleSelectionGenerate("visuals")} disabled={busy}
          style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "none", cursor: busy ? "not-allowed" : "pointer", background: "rgba(59,130,246,0.8)", color: "#fff" }}>📊 시각화 추천</button>
        <button onClick={() => handleSelectionGenerate("inserts")} disabled={busy}
          style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "none", cursor: busy ? "not-allowed" : "pointer", background: "rgba(245,158,11,0.8)", color: "#fff" }}>🎬 인서트 컷</button>
        <button onClick={clearTextSel}
          style={{ fontSize: 11, padding: "5px 8px", borderRadius: 6, border: `1px solid ${C.bd}`, background: "transparent", color: C.txD, cursor: "pointer" }}>✕</button>
      </div>
    )}

    {/* Status bar */}
    {loaded && <div style={{ padding: "4px 20px", fontSize: 10, color: C.txD, borderTop: `1px solid ${C.bd}`, background: C.sf, display: "flex", gap: 8, flexShrink: 0 }}>
      <span>블록: {blocks.length}</span>
      {visualGuides.length > 0 && <><span style={{ color: C.txD }}>|</span><span>시각화: <b style={{ color: "#3B82F6" }}>{visualGuides.length}</b></span></>}
      {insertCuts.length > 0 && <><span style={{ color: C.txD }}>|</span><span>인서트컷: <b style={{ color: "#F59E0B" }}>{insertCuts.length}</b></span></>}
      {Object.values(verdicts).filter(v => v === "use").length > 0 && <><span style={{ color: C.txD }}>|</span><span>사용: <b style={{ color: C.ok }}>{Object.values(verdicts).filter(v => v === "use").length}</b></span></>}
    </div>}

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
