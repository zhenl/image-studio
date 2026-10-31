/* Image Studio 前端（原生 JS，无构建步骤） */
const API = "/api/v1";
const MAX_REFS = 9;

const state = {
  mode: "txt2img",
  refMode: "auto",
  refImages: [],       // data URL，有序
  eventSource: null,
};

const $ = (id) => document.getElementById(id);
const els = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/* ============ 参数收集与校验 ============ */
function activeRefMode() {
  if (state.refMode !== "auto") return state.refMode;
  return state.refImages.length > 1 ? "edit" : "classic";
}

function collectParams() {
  const p = {
    prompt: $("prompt").value.trim(),
    negative_prompt: "",
    width: Number(document.querySelector("#sizePreset .active").dataset.w),
    height: Number(document.querySelector("#sizePreset .active").dataset.h),
    steps: Number($("steps").value),
    guidance_scale: Number($("guidance").value),
    seed: Number($("seed").value),
    batch_size: Number($("batch").value),
    mode: state.mode,
    ref_mode: state.refMode,
    strength: Number($("strength").value),
  };
  if (state.mode === "img2img") p.ref_images = state.refImages.slice();
  return p;
}

function validate(p) {
  if (!p.prompt) return "请先输入提示词";
  if (p.mode === "img2img" && !state.refImages.length) return "图生图模式请先添加至少一张参考图";
  return null;
}

/* ============ 参考图九宫格 ============ */
function renderRefStrip() {
  const strip = $("refStrip");
  strip.innerHTML = "";
  for (let i = 0; i < MAX_REFS; i++) {
    const slot = document.createElement("div");
    const data = state.refImages[i];
    slot.className = "ref-slot" + (data ? "" : " empty");
    slot.innerHTML = data
      ? `<img src="${data}" alt=""><span class="ref-order">${i + 1}</span><button class="ref-del" data-i="${i}">✕</button>`
      : `<span>＋</span>`;
    slot.onclick = (e) => {
      if (e.target.classList.contains("ref-del")) {
        state.refImages.splice(Number(e.target.dataset.i), 1);
        renderRefStrip();
        return;
      }
      if (!data) pickRefs();
    };
    strip.appendChild(slot);
  }
  $("refModeHint").textContent = state.refImages.length
    ? `已添加 ${state.refImages.length}/${MAX_REFS} 张 · 当前生效：${activeRefMode() === "edit" ? "智能编辑" : "传统重绘"}`
    : "点击 ＋ 或拖入图片（支持多选）";
  $("tokenChips").style.display = state.mode === "img2img" ? "" : "none";
  $("strengthRow").style.display = activeRefMode() === "classic" ? "" : "none";
}

function pickRefs() {
  const room = MAX_REFS - state.refImages.length;
  if (room <= 0) { toast(`参考图最多 ${MAX_REFS} 张`); return; }
  $("refFile").click();
}

$("refFile").addEventListener("change", (e) => {
  const files = [...e.target.files].slice(0, MAX_REFS - state.refImages.length);
  for (const f of files) {
    const reader = new FileReader();
    reader.onload = () => { state.refImages.push(reader.result); renderRefStrip(); scheduleEstimate(); };
    reader.readAsDataURL(f);
  }
  e.target.value = "";
});

// 拖拽进参考图区
for (const ev of ["dragover", "drop"]) {
  $("refStrip").addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "drop") {
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"))
        .slice(0, MAX_REFS - state.refImages.length);
      for (const f of files) {
        const reader = new FileReader();
        reader.onload = () => { state.refImages.push(reader.result); renderRefStrip(); };
        reader.readAsDataURL(f);
      }
    }
  });
}

/* ============ 估算 ============ */
let estimateTimer = null;
let estimateHadWarning = false;
function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(runEstimate, 260);
}
async function runEstimate() {
  const active = document.querySelector("#sizePreset .active");
  try {
    const data = await api("/preview", {
      method: "POST",
      body: JSON.stringify({
        width: Number(active.dataset.w), height: Number(active.dataset.h),
        steps: Number($("steps").value), batch_size: Number($("batch").value),
      }),
    });
    let text = `预估 ${data.estimated_seconds.toFixed(1)}s · ${data.megapixels}MP`;
    if (data.estimated_vram_gb) text += ` · 约 ${data.estimated_vram_gb}GB 显存`;
    text += data.calibrated ? `（按本机近 ${data.samples} 次出图校准）` : "（未校准，保守参考值）";
    $("estimate").textContent = text;
    if (data.warnings.length) { estimateHadWarning = true; showError(data.warnings.join("；")); }
    else if (estimateHadWarning) { estimateHadWarning = false; showError(null); }
  } catch { /* 静默 */ }
}

function showError(msg) {
  const box = $("errorBox");
  if (!msg) { box.classList.add("hidden"); $("errorText").textContent = ""; return; }
  $("errorText").textContent = msg;
  box.classList.remove("hidden");
}

/* ============ 生成 ============ */
function setBusy(busy) {
  $("btnGenerate").disabled = busy;
  $("btnGenerate").textContent = busy ? "生成中…" : "开始生成";
  $("progressBar").classList.toggle("hidden", !busy);
}

function setProgress(pct, text) {
  $("progressFill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) $("progressText").textContent = text;
}

function appendResult(url) {
  const cell = document.createElement("div");
  cell.className = "result-cell";
  cell.innerHTML = `<img src="${url}" loading="lazy" alt="">`;
  cell.onclick = () => window.open(url, "_blank");
  $("canvasResults").prepend(cell);
}

async function doGenerate() {
  const p = collectParams();
  const err = validate(p);
  if (err) { showError(err); return; }
  showError(null);
  $("canvasResults").innerHTML = "";
  setBusy(true);
  setProgress(2, "提交中…");
  try {
    const job = await api("/generate", { method: "POST", body: JSON.stringify(p) });
    (job.images || []).forEach((im) => appendResult(im.url));
    setProgress(100, `完成（${job.images?.length ?? 0} 张）`);
    refreshGallery(); refreshStatus();
  } catch (e) {
    showError(e.message);
    setProgress(0, "失败");
  } finally {
    setBusy(false);
  }
}

async function doQueue() {
  const p = collectParams();
  const err = validate(p);
  if (err) { showError(err); return; }
  showError(null);
  try {
    const res = await api("/jobs", { method: "POST", body: JSON.stringify(p) });
    toast(`已加入队列（前方 ${res.position - 1} 个任务）`);
    switchTab("jobs");
    refreshJobs();
    subscribeJob(res.job_id);
  } catch (e) {
    showError(e.message);
  }
}

function subscribeJob(jobId) {
  if (state.eventSource) state.eventSource.close();
  const es = new EventSource(`${API}/jobs/${jobId}/events`);
  state.eventSource = es;
  es.addEventListener("progress", (e) => {
    const d = JSON.parse(e.data);
    setProgress(d.percent, `第 ${d.step}/${d.total} 张：采样中`);
  });
  es.addEventListener("image", (e) => {
    const d = JSON.parse(e.data);
    appendResult(d.url);
  });
  es.addEventListener("done", () => {
    es.close();
    state.eventSource = null;
    setProgress(100, "完成");
    refreshGallery(); refreshJobs(); refreshStatus();
  });
  es.addEventListener("error", () => { es.close(); state.eventSource = null; });
}

/* ============ 图库 / 任务 / 状态 ============ */
async function refreshGallery() {
  try {
    const data = await api("/gallery?limit=60");
    $("galleryGrid").innerHTML = "";
    for (const im of data.items) {
      const cell = document.createElement("div");
      cell.className = "result-cell";
      cell.innerHTML = `<img src="${im.url}" loading="lazy" alt="">
        <button class="fav ${im.favorite ? "on" : ""}" data-id="${im.id}">${im.favorite ? "★" : "☆"}</button>`;
      cell.querySelector(".fav").onclick = async (e) => {
        e.stopPropagation();
        await api(`/gallery/${im.id}/favorite`, { method: "POST", body: JSON.stringify({ favorite: !im.favorite }) });
        refreshGallery();
      };
      $("galleryGrid").appendChild(cell);
    }
  } catch { /* 静默 */ }
}

async function refreshJobs() {
  try {
    const data = await api("/jobs?limit=20");
    $("jobsList").innerHTML = data.items.map((j) => `
      <div class="job-row">
        <span class="badge ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : ""}">${j.status}</span>
        <span class="muted">${j.created_at.replace("T", " ").slice(0, 19)}</span>
        <span>${j.prompt.slice(0, 40)}</span>
        <span class="muted">${j.progress}%</span>
      </div>`).join("");
  } catch { /* 静默 */ }
}

async function refreshStatus() {
  try {
    const s = await api("/status");
    const badge = $("engineBadge");
    badge.className = "badge";
    if (s.engine_mode === "mock") { badge.textContent = "演示模式"; }
    else if (s.loaded) { badge.textContent = "ComfyUI 已连接"; badge.classList.add("ok"); }
    else { badge.textContent = "ComfyUI 未连接"; badge.classList.add("err"); }
    const parts = [];
    if (s.gpu_name) parts.push(s.gpu_name);
    if (s.comfyui_url) parts.push(s.comfyui_url);
    if (s.vram_total_gb) parts.push(`显存 ${s.vram_total_gb}GB`);
    if (s.queue_size) parts.push(`队列 ${s.queue_size}`);
    $("statusInfo").textContent = parts.join(" · ") || "—";
  } catch { /* 静默 */ }
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ============ 交互绑定 ============ */
function switchTab(name) {
  els(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  els(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${name}`));
  if (name === "gallery") refreshGallery();
  if (name === "jobs") refreshJobs();
}

function bindEvents() {
  els("#modeSwitch .seg").forEach((btn) => {
    btn.onclick = () => {
      state.mode = btn.dataset.mode;
      els("#modeSwitch .seg").forEach((b) => b.classList.toggle("active", b === btn));
      $("refField").style.display = state.mode === "img2img" ? "" : "none";
      renderRefStrip();
    };
  });
  els("#refModeSwitch .seg").forEach((btn) => {
    btn.onclick = () => {
      state.refMode = btn.dataset.refmode;
      els("#refModeSwitch .seg").forEach((b) => b.classList.toggle("active", b === btn));
      renderRefStrip();
    };
  });
  els("#sizePreset .seg").forEach((btn) => {
    btn.onclick = () => {
      els("#sizePreset .seg").forEach((b) => b.classList.toggle("active", b === btn));
      scheduleEstimate();
    };
  });
  els(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  els(".chip").forEach((c) => {
    c.onclick = () => {
      const ta = $("prompt");
      const token = `<${c.dataset.token.replace("_", "")}>`;
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + token + " " + ta.value.slice(ta.selectionEnd ?? pos);
      ta.focus();
      $("promptLen").textContent = ta.value.length;
    };
  });
  $("prompt").addEventListener("input", (e) => {
    $("promptLen").textContent = e.target.value.length;
  });
  for (const id of ["steps", "guidance", "batch"]) {
    $(id).addEventListener("input", (e) => {
      $(id + "Val").textContent = e.target.value;
      scheduleEstimate();
    });
  }
  $("btnRandomSeed").onclick = () => { $("seed").value = Math.floor(Math.random() * 2147483647); };
  $("btnGenerate").onclick = doGenerate;
  $("btnQueue").onclick = doQueue;
}

renderRefStrip();
bindEvents();
scheduleEstimate();
refreshStatus();
refreshGallery();
setInterval(refreshStatus, 15000);
