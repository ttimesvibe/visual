// visual — Cloudflare Worker
// 3단계 시각화 가이드 + 4단계 인서트 컷 가이드 (Gemini 2.5 Flash)
// 독립 테스트용 — ttimes-doctor와 분리

// ═══════════════════════════════════════
// JWT 인증 + CORS
// ═══════════════════════════════════════

const ALLOWED_ORIGINS = [
  "https://ttimesvibe.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
];

function getAllowedOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

async function verifyJWT(token, secret) {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Invalid token format");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sigBuf = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sigBuf, enc.encode(`${headerB64}.${payloadB64}`));
  if (!valid) throw new Error("Invalid signature");
  const payloadBytes = Uint8Array.from(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  if (payload.exp && payload.exp < Date.now() / 1000) throw new Error("Token expired");
  return payload;
}

async function verifyAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: "Missing token" };
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    return { ok: true, user: payload };
  } catch (e) {
    return { ok: false, status: 401, error: e.message };
  }
}

export default {
  async fetch(request, env) {
    const origin = getAllowedOrigin(request);
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // JWT 인증 검증
    const auth = await verifyAuth(request, env);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), { status: auth.status, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), colo: request.cf?.colo }), { headers: corsHeaders });
    }

    // GET /load/:id — 세션 불러오기
    const loadMatch = path.match(/^\/load\/([a-zA-Z0-9]+)$/);
    if (loadMatch && request.method === "GET") {
      if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers: corsHeaders });
      const data = await env.SESSIONS.get(loadMatch[1]);
      if (!data) return new Response(JSON.stringify({ error: "세션을 찾을 수 없습니다." }), { status: 404, headers: corsHeaders });
      return new Response(data, { headers: corsHeaders });
    }

    // GET /sessions — 세션 목록
    if (path === "/sessions" && request.method === "GET") {
      if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers: corsHeaders });
      const indexData = await env.SESSIONS.get("visual_session_index");
      const index = indexData ? JSON.parse(indexData) : [];
      return new Response(JSON.stringify({ success: true, sessions: index }), { headers: corsHeaders });
    }

    try {
      const body = await request.json();
      if (path === "/visuals") return await handleVisuals(body, env, corsHeaders);
      else if (path === "/insert-cuts") return await handleInsertCuts(body, env, corsHeaders);
      else if (path === "/save") {
        // 세션 저장 (기존 ID 덮어쓰기 지원)
        if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers: corsHeaders });
        const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
        const { id: _discard, ...rest } = body;
        const savedAt = new Date().toISOString();
        await env.SESSIONS.put(id, JSON.stringify({ ...rest, savedAt }), { expirationTtl: 60*60*24*30 });
        // 세션 인덱스 업데이트
        try {
          const indexData = await env.SESSIONS.get("visual_session_index");
          const index = indexData ? JSON.parse(indexData) : [];
          const entry = { id, fn: body.fn || "제목 없음", savedAt, blockCount: body.blocks?.length || 0, visCount: body.visualGuides?.length || 0, icCount: body.insertCuts?.length || 0 };
          const existing = index.findIndex(s => s.id === id);
          if (existing >= 0) index[existing] = entry; else index.unshift(entry);
          await env.SESSIONS.put("visual_session_index", JSON.stringify(index.slice(0, 50)));
        } catch (e) { console.error("인덱스 업데이트 실패:", e.message); }
        return new Response(JSON.stringify({ success: true, id }), { headers: corsHeaders });
      }
      else if (path === "/session-delete") {
        if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers: corsHeaders });
        const { id } = body;
        if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: corsHeaders });
        await env.SESSIONS.delete(id);
        try {
          const indexData = await env.SESSIONS.get("visual_session_index");
          const index = indexData ? JSON.parse(indexData) : [];
          await env.SESSIONS.put("visual_session_index", JSON.stringify(index.filter(s => s.id !== id)));
        } catch (e) {}
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      else return new Response(JSON.stringify({ error: "Unknown endpoint. Use /visuals, /insert-cuts, /save" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  },
};

// ═══════════════════════════════════════
// Gemini API 호출 공통 함수
// ═══════════════════════════════════════

async function callGemini(prompt, env, options = {}) {
  const { temperature = 0.2, maxOutputTokens = 16000, model = "gemini-2.5-flash" } = options;
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return { error: "GEMINI_API_KEY not configured" };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    return { error: `Gemini API error ${response.status}: ${errText}`, status: response.status };
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) return { error: "Gemini returned empty response" };

  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const braceStart = jsonStr.indexOf('{');
  const braceEnd = jsonStr.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1) jsonStr = jsonStr.substring(braceStart, braceEnd + 1);

  try {
    return { content: JSON.parse(jsonStr), usage: data.usageMetadata };
  } catch (e) {
    return { error: `JSON parse error: ${e.message}. Raw (first 500): ${text.substring(0, 500)}` };
  }
}

// ═══════════════════════════════════════
// /visuals — 3단계: 시각화 가이드
// ═══════════════════════════════════════

const VISUALS_SYSTEM_PROMPT = `당신은 인터뷰 영상의 시각화 가이드 전문가입니다.
인터뷰 내용 중 "말로만 설명하면 시청자가 이해하기 어려운 부분"을 찾아,
영상 편집자가 표·그래프·다이어그램을 제작할 수 있도록 구체적인 시각화 가이드를 생성합니다.

## 역할
- 당신은 시각화 자체를 만드는 것이 아닙니다
- 프론트엔드 템플릿이 렌더링할 수 있는 **구조화된 JSON 데이터**를 출력합니다
- 편집자가 이 목업을 참고하여 영상용 그래픽을 제작합니다

## §1 핵심 원칙

1. **노트북LM 방식**: 전체 내용을 이해한 뒤, 시청자가 반드시 이해해야 할 핵심 부분을 추출하여 시각화
2. **빈도 제한 없음**: 시각화 가치가 있다고 판단되면 모두 추천. 편집자가 최종 선별
3. **위치 매칭**: 시각화 포인트를 먼저 추출한 뒤, 스크립트 내 가장 적합한 삽입 위치(block_range)를 역으로 매칭
4. **환각 금지**: 원문에 없는 수치나 사실을 만들어내지 마세요. 원문에 언급된 내용만 시각화
5. **우선순위 표시**: 각 시각화에 priority(high/medium/low)를 부여하여 편집자 판단을 도움

## §2 시각화 판단 기준

### 시각화가 필요한 경우
- **비교/대조**: 두 개 이상의 개념을 나란히 비교하는 구간
- **프로세스/단계**: 순서가 있는 흐름 설명
- **분류/구조**: 여러 항목을 카테고리로 나누는 설명
- **변화/진화**: 시간에 따른 변화
- **수치/데이터**: 구체적 숫자나 비율이 언급되는 구간
- **복잡한 개념**: 추상적이거나 기술적인 내용이 길게 설명되는 구간
- **핵심 프레임워크**: 게스트가 제시하는 분석 틀이나 사고 방식

### 시각화가 불필요한 경우
- 이미 쉽게 이해되는 일상적 설명
- 단순한 의견, 감상, 농담
- 잡담, 리액션, 전환 멘트
- 강조 자막 한 줄이면 충분한 짧은 인사이트
- 원문에 구체적 내용이 없는 막연한 언급

## §3 시각화 유형 (21종)

### A. 차트/그래프 (수치 데이터)
bar, bar_horizontal, bar_stacked, line, area, donut, bubble, radar, scatter, polar, mixed

### B. 표/비교 (정보 구조화)
comparison, table, checklist, ranking

### C. 구조/관계 다이어그램
process, structure, hierarchy, cycle, network, venn

### D. 타임라인/진행
timeline, timeline_horizontal, progress

### E. 개념 시각화
kpi, matrix, stack

## §4 출력 형식

반드시 아래 JSON 형식만 출력하세요. JSON 외 텍스트를 출력하지 마세요.

{
  "visual_guides": [
    {
      "id": 1,
      "block_range": [37, 39],
      "title": "시각화 제목",
      "type": "bar",
      "priority": "high",
      "description": "이 시각화가 필요한 이유 (편집자용 설명)",
      "source_summary": "원문에서 언급된 내용 요약",
      "chart_data": { ... },
      "duration_seconds": 6,
      "reason": "왜 시각화가 필요한지 한 줄 설명"
    }
  ]
}

### chart_data 스키마 (type별):

**차트 유형** (bar, bar_horizontal, bar_stacked, line, area, mixed):
{ "labels": ["항목1","항목2"], "datasets": [{ "label": "데이터셋명", "data": [62, 82], "colors": ["#6B7280","#3B82F6"] }], "unit": "점", "y_min": 50, "y_max": 100 }

**donut**: { "labels": ["A","B"], "datasets": [{ "data": [60,40], "colors": ["#3B82F6","#EF4444"] }], "unit": "%" }

**radar**: { "labels": ["축1","축2","축3"], "datasets": [{ "label": "A사", "data": [80,90,70] }] }

**scatter/bubble**: { "datasets": [{ "label": "그룹명", "data": [{"x":1,"y":2,"r":10}] }], "x_label": "X축", "y_label": "Y축" }

**comparison**: { "columns": [{ "label": "장점", "tone": "positive", "items": ["항목1","항목2"] }, { "label": "단점", "tone": "negative", "items": ["항목1"] }], "footer": "요약 한 줄" }

**table**: { "headers": ["열1","열2"], "rows": [["데이터1","데이터2"]], "highlight_rows": [0] }

**checklist**: { "headers": ["기능","A","B"], "rows": [["기능1","O","X"]] }

**ranking**: { "items": [{ "rank": 1, "label": "항목명", "value": "수치", "description": "설명" }] }

**process**: { "steps": [{ "label": "단계명", "description": "설명" }] }

**structure**: { "items": [{ "num": 1, "label": "항목명", "description": "설명", "color": "purple" }], "layout": "2x2" }

**hierarchy**: { "root": { "label": "루트", "children": [{ "label": "자식1", "children": [] }] } }

**cycle**: { "steps": [{ "label": "단계명", "description": "설명" }] }

**network**: { "nodes": [{ "id": "n1", "label": "노드명" }], "edges": [{ "from": "n1", "to": "n2", "label": "관계" }] }

**venn**: { "sets": [{ "label": "집합A", "items": ["항목1"] }], "intersection": { "label": "교집합", "items": ["공통항목"] } }

**timeline/timeline_horizontal**: { "events": [{ "period": "2022~2023", "label": "이벤트명", "description": "설명" }] }

**progress**: { "steps": [{ "label": "단계명", "status": "done" }], "current": 2 }

**kpi**: { "metrics": [{ "value": "100배", "label": "라벨", "trend": "up" }] }

**matrix**: { "x_axis": "X축명", "y_axis": "Y축명", "quadrants": [{ "position": "top-right", "label": "영역명", "items": ["항목"] }] }

**stack**: { "layers": [{ "label": "레이어명", "description": "설명", "color": "blue" }] }

## §5 절대 규칙

1. 원문에 없는 수치/사실을 만들어내지 마세요 (환각 금지)
2. 교정된 용어를 사용하세요
3. block_range는 반드시 실제 블록 인덱스와 일치해야 합니다
4. JSON 외 텍스트를 출력하지 마세요
5. 각 시각화에 priority(high/medium/low)를 반드시 부여하세요
6. type은 §3의 유형 중에서만 선택하세요
7. chart_data의 구조는 type에 맞는 스키마를 정확히 따르세요`;

async function handleVisuals(body, env, headers) {
  const { blocks, analysis, chunk_index, total_chunks, existing_count, preferred_type } = body;
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return new Response(JSON.stringify({ error: "blocks array is required" }), { status: 400, headers });
  }

  let blockText = "";
  for (const b of blocks) {
    blockText += `[블록 ${b.index}] ${b.speaker || ""} ${b.timestamp || ""}\n${b.text}\n\n`;
  }

  let prompt = VISUALS_SYSTEM_PROMPT;

  if (analysis) {
    prompt += `\n\n## Step 0 분석 결과`;
    if (analysis.overview?.topic) prompt += `\n주제: ${analysis.overview.topic}`;
    if (analysis.genre?.primary) prompt += `\n장르: ${analysis.genre.primary}`;
    if (analysis.tech_difficulty) prompt += `\n기술 난이도: ${analysis.tech_difficulty}`;
    if (analysis.domain_terms?.length > 0) {
      prompt += `\n\n## 도메인 전문용어`;
      for (const dt of analysis.domain_terms) prompt += `\n- ${dt.term} (${dt.english})`;
    }
    if (analysis.selected_text) {
      prompt += `\n\n## ★ 사용자 선택 구간 (이 부분에 집중하여 시각화 추천)\n"${analysis.selected_text}"`;
    }
  }

  if (chunk_index !== undefined && total_chunks !== undefined) {
    prompt += `\n\n## 청크 정보\n청크 ${chunk_index + 1}/${total_chunks}.`;
    if (existing_count > 0) {
      prompt += `\n앞 청크에서 이미 ${existing_count}건의 시각화 가이드가 생성되었습니다.\n중복되지 않는 새로운 시각화 포인트에 집중하세요.`;
    }
  }

  // 사용자가 카테고리를 지정한 경우
  if (preferred_type) {
    prompt += `\n\n## 지정된 시각화 유형\n반드시 "${preferred_type}" 유형으로 시각화를 생성하세요.`;
  }

  prompt += `\n\n## 교정본\n\n${blockText}`;

  const result = await callGemini(prompt, env, { temperature: 0.2, maxOutputTokens: 16000 });
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), { status: result.status || 500, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    result: result.content,
    usage: result.usage,
  }), { headers });
}

// ═══════════════════════════════════════
// /insert-cuts — 4단계: 인서트 컷 가이드
// ═══════════════════════════════════════

const INSERT_CUTS_SYSTEM_PROMPT = `당신은 인터뷰 영상의 인서트 컷 가이드 전문가입니다.
인터뷰 영상에서 두 사람이 앉아 말만 하는 화면이 단조로워지는 구간을 찾아,
영상 편집자가 삽입할 수 있는 외부 자료(이미지, 유튜브 클립, 일러스트)를 추천합니다.

## 역할
- "여기에 이런 자료를 넣어라"는 편집자 지시서를 만듭니다
- 실제 이미지를 생성하지 않습니다
- 공식 소스(기업 공식 블로그, 공식 유튜브 채널)를 우선 추천합니다
- 유튜브 영상의 타임스탬프를 추측하지 마세요. 영상 제목과 링크만 제공합니다

## §1 인서트 컷 유형 (3종)

### Type A: 과거 회상 에피소드 일러스트
실제 영상 자료가 없는 과거 경험담을 시각적으로 보완하는 삽입물.

**트리거 조건 (3가지 모두 충족):**
1. **시제**: 과거형 회상 어투 — "~했었어요", "~했거든요", "그때~", "~한 적이 있어요"
2. **장소/시기 전환**: 화자의 인생 타임라인상 특정 시점으로 이동
3. **감정적 전환점**: 문제→깨달음→행동 구조가 있는 서사

**삽입되지 않는 과거 회상 (반례):**
- 공적 사건 언급 ("알파고가 나왔잖아요") → 본인의 개인 경험이 아님
- 구체적 에피소드 없는 행동 나열 ("강의 보고 공부했어요") → 감정적 전환점 없음
- 타인의 에피소드 ("그 친구가 우승했어요") → 본인 서사가 아님

**출력**: 이미지 생성 도구에 넣을 수 있는 영문 image_prompt 제공

### Type B: 공식 이미지 / 유튜브 영상 클립
특정 기업·제품·서비스·기술이 언급될 때 공식 소스에서 제공하는 시각 자료.

**트리거 조건 (2가지 모두 충족):**
1. **고유명사 도구/서비스/기업명**: 구체적 이름이 등장
2. **기능/작동 방식 설명**: 그 도구가 어떻게 작동하는지 설명하는 발화

**트리거되지 않는 도구 언급 (반례):**
- 이름만 스쳐 지나감 → 작동 방식 설명 없음
- 과거에 썼다는 언급만 → Type A 에피소드로 처리
- 이름 나열 → 개별 기능 설명 없음

**2단계 삽입 패턴:**
1. 일반 소개 → 공식 이미지 or 유튜브
2. 본인 사용 사례 (구체적 수치) → 게스트 캡처 요청

### Type C: 작품/성과물 실물 사진
화자가 만든 작품이나 참여한 행사의 실물.

**트리거 조건 (2가지 모두 충족):**
1. **성과물 고유명사**: 전시회명, 작품명, 수상명 등
2. **공식성/외부 인정**: 전시회 출품, 수상, 공식 발표 등

## §2 유튜브 영상 추천 규칙
1. 공식 채널 우선
2. **타임스탬프 추측 금지**
3. 영상 제목, 채널명, 검색 키워드만 제공

## §3 출력 형식

반드시 아래 JSON 형식만 출력하세요. JSON 외 텍스트를 출력하지 마세요.

{
  "insert_cuts": [
    {
      "id": 1,
      "block_range": [12, 14],
      "type": "A",
      "type_name": "과거 회상 일러스트",
      "title": "제목",
      "speaker": "화자명",
      "trigger_quote": "트리거 발화 원문 (50자 이내)",
      "trigger_reason": "왜 인서트 컷이 필요한지 트리거 조건 매칭 설명",
      "instruction": "편집자에게 전달할 구체적 지시",
      "image_prompt": "영문 이미지 생성 프롬프트 (Type A만)",
      "source_type": "illustration | official_image | official_youtube | guest_provided",
      "search_keywords": ["검색 키워드1", "키워드2"],
      "youtube_search": { "query": "검색어", "preferred_channels": ["채널명"], "note": "참고사항" },
      "asset_note": "자료 확보 참고사항"
    }
  ]
}

## §4 절대 규칙
1. 유튜브 타임스탬프 추측 금지
2. 공식 소스 우선
3. Type A image_prompt: 영문, 구체적 장면 묘사, 스타일 지정 포함
4. 반례 준수: §1에 명시된 반례에 해당하면 생성하지 마세요
5. 교정된 용어 사용
6. block_range 정확히
7. JSON 외 텍스트 출력 금지`;

async function handleInsertCuts(body, env, headers) {
  const { blocks, analysis, chunk_index, total_chunks, existing_count } = body;
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return new Response(JSON.stringify({ error: "blocks array is required" }), { status: 400, headers });
  }

  let blockText = "";
  for (const b of blocks) {
    blockText += `[블록 ${b.index}] ${b.speaker || ""} ${b.timestamp || ""}\n${b.text}\n\n`;
  }

  let prompt = INSERT_CUTS_SYSTEM_PROMPT;

  if (analysis) {
    prompt += `\n\n## Step 0 분석 결과`;
    if (analysis.overview?.topic) prompt += `\n주제: ${analysis.overview.topic}`;
    if (analysis.genre?.primary) prompt += `\n장르: ${analysis.genre.primary}`;
    if (analysis.speakers?.length > 0) {
      prompt += `\n화자: ${analysis.speakers.map(s => `${s.name}(${s.role || ""})`).join(", ")}`;
    }
    if (analysis.selected_text) {
      prompt += `\n\n## ★ 사용자 선택 구간 (이 부분에 집중하여 인서트 컷 추천)\n"${analysis.selected_text}"`;
    }
  }

  if (chunk_index !== undefined && total_chunks !== undefined) {
    prompt += `\n\n## 청크 정보\n청크 ${chunk_index + 1}/${total_chunks}.`;
    if (existing_count > 0) {
      prompt += `\n앞 청크에서 이미 ${existing_count}건의 인서트 컷 가이드가 생성되었습니다.\n중복되지 않는 새로운 인서트 컷 포인트에 집중하세요.`;
    }
  }

  prompt += `\n\n## 교정본\n\n${blockText}`;

  const result = await callGemini(prompt, env, { temperature: 0.2, maxOutputTokens: 16000 });
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error }), { status: result.status || 500, headers });
  }

  return new Response(JSON.stringify({
    success: true,
    result: result.content,
    usage: result.usage,
  }), { headers });
}
