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
    negative_prompt: $("negative").value.trim(),
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

/* 画布：大图 + 底部缩略图条（本次生成的批次），点击切换 */
let canvasImages = [];   // [{url, seed}]
let canvasIndex = 0;

function appendResult(url) {
  canvasImages.push({ url });
  canvasIndex = canvasImages.length - 1;
  renderCanvas();
}

function renderCanvas() {
  const main = $("canvasMain");
  if (!canvasImages.length) {
    main.innerHTML = '<p class="muted">还没有生成结果——输入提示词后点击「开始生成」</p>';
    $("canvasStrip").classList.add("hidden");
    return;
  }
  const cur = canvasImages[canvasIndex];
  main.innerHTML = `<img class="canvas-big" src="${cur.url}" alt="生成结果">`;
  main.querySelector("img").onclick = () => openImageByUrl(cur.url);
  const strip = $("canvasStrip");
  if (canvasImages.length > 1) {
    strip.classList.remove("hidden");
    strip.innerHTML = "";
    canvasImages.forEach((im, i) => {
      const t = document.createElement("div");
      t.className = "canvas-thumb" + (i === canvasIndex ? " active" : "");
      t.innerHTML = `<img src="${im.url}" alt="">`;
      t.onclick = () => { canvasIndex = i; renderCanvas(); };
      strip.appendChild(t);
    });
  } else {
    strip.classList.add("hidden");
  }
}

function openImageByUrl(url) {
  const found = state.galleryCache?.find((g) => g.url === url);
  if (found) openImageModal(found);
  else window.open(url, "_blank");
}

async function doGenerate() {
  const p = collectParams();
  const err = validate(p);
  if (err) { showError(err); return; }
  showError(null);
  canvasImages = []; canvasIndex = 0; renderCanvas();
  setBusy(true);
  setProgress(2, "提交中…");
  try {
    refreshJobs();
    const job = await api("/generate", { method: "POST", body: JSON.stringify(p) });
    (job.images || []).forEach((im) => appendResult(im.url));
    refreshGallery(); refreshJobs();
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
const galleryState = { selectMode: false, selIds: new Set() };
state.galleryCache = [];

async function refreshGallery() {
  try {
    const data = await api("/gallery?limit=60");
    state.galleryCache = data.items || [];
    const grid = $("galleryGrid");
    grid.innerHTML = "";
    $("galleryCount").textContent = state.galleryCache.length ? `${state.galleryCache.length} 张` : "";
    for (const im of state.galleryCache) {
      const cell = document.createElement("div");
      cell.className = "result-cell";
      cell.innerHTML = `<img src="${im.url}" loading="lazy" alt="">` +
        (galleryState.selectMode
          ? `<span class="check ${galleryState.selIds.has(im.id) ? "on" : ""}" data-id="${im.id}">${galleryState.selIds.has(im.id) ? "✓" : ""}</span>`
          : `<button class="fav ${im.favorite ? "on" : ""}" data-id="${im.id}">${im.favorite ? "★" : "☆"}</button>`);
      cell.onclick = async () => {
        if (galleryState.selectMode) {
          galleryState.selIds.has(im.id) ? galleryState.selIds.delete(im.id) : galleryState.selIds.add(im.id);
          refreshGallery();
          return;
        }
        openImageModal(im);
      };
      const fav = cell.querySelector(".fav");
      if (fav) fav.onclick = async (e) => {
        e.stopPropagation();
        await api(`/gallery/${im.id}/favorite`, { method: "POST", body: JSON.stringify({ favorite: !im.favorite }) });
        refreshGallery();
      };
      grid.appendChild(cell);
    }
  } catch { /* 静默 */ }
}

function setGallerySelectMode(on) {
  galleryState.selectMode = on;
  galleryState.selIds.clear();
  $("galleryBatchBar").classList.toggle("hidden", !on);
  $("btnGallerySelect").classList.toggle("hidden", on);
  refreshGallery();
}

async function batchZip() {
  const ids = [...galleryState.selIds];
  if (!ids.length) { toast("请先选择图片"); return; }
  toast(`正在打包 ${ids.length} 张…`);
  try {
    const res = await fetch(`${API}/gallery/batch-download?ids=${encodeURIComponent(ids.join(","))}`);
    if (!res.ok) throw new Error(`打包失败 (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `image-studio-${ids.length}images.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已下载 ${ids.length} 张（zip）`);
  } catch (e) { toast(e.message); }
}

async function batchDeleteGallery() {
  const ids = [...galleryState.selIds];
  if (!ids.length) { toast("请先选择图片"); return; }
  if (!confirm(`确定删除选中的 ${ids.length} 张图片？文件会一并删除，不可恢复。`)) return;
  try {
    const res = await api("/gallery/batch-delete", { method: "POST", body: JSON.stringify({ ids }) });
    toast(res.message);
    galleryState.selIds.clear();
    refreshGallery();
  } catch (e) { toast(e.message); }
}

/* 图片详情弹窗 */
function fmtTime(iso) { return (iso || "").replace("T", " ").slice(0, 19); }

function openImageModal(im) {
  $("imageModalImg").src = im.url;
  $("imageModalDownload").href = im.url;
  $("imageModalDownload").setAttribute("download", `image-${im.seed ?? im.id}.png`);
  $("imageModalMeta").innerHTML = `
    <div><b>提示词</b>：${escapeHtml(im.prompt || "—")}</div>
    ${im.negative ? `<div><b>负面</b>：${escapeHtml(im.negative)}</div>` : ""}
    <div class="muted">${im.width || "?"} × ${im.height || "?"} · ${im.steps ?? "?"} 步 · 引导 ${im.guidance ?? "?"} · 种子 ${im.seed ?? "?"} · ${im.elapsed_ms ? (im.elapsed_ms / 1000).toFixed(1) + "s" : ""} · ${fmtTime(im.created_at)}${im.mode === "img2img" ? ` · ${im.ref_mode === "edit" ? "智能编辑" : "传统重绘"}` : ""}</div>`;
  $("imageModalDelete").onclick = async () => {
    if (!confirm("确定删除这张图片？文件会一并删除，不可恢复。")) return;
    try {
      await api(`/gallery/${im.id}`, { method: "DELETE" });
      toast("已删除");
      $("imageModal").classList.add("hidden");
      refreshGallery();
    } catch (e) { toast(e.message); }
  };
  $("imageModal").classList.remove("hidden");
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const jobsState = { selectMode: false, selIds: new Set() };

function renderJobsList(items) {
  const list = $("jobsList");
  list.innerHTML = "";
  for (const j of items) {
    const row = document.createElement("div");
    row.className = "job-row";
    row.innerHTML = `
      ${jobsState.selectMode ? `<input type="checkbox" data-id="${j.id}" ${jobsState.selIds.has(j.id) ? "checked" : ""}>` : ""}
      <span class="badge ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : ""}">${j.status}</span>
      <span class="muted">${j.created_at.replace("T", " ").slice(0, 19)}</span>
      <span class="job-prompt">${escapeHtml(j.prompt.slice(0, 40))}</span>
      <span class="muted">${j.progress}%</span>
      <button class="btn ghost small" data-act="detail">详情</button>`;
    row.onclick = (e) => {
      if (e.target.dataset.act === "detail" || e.target === row) openJobModal(j.id);
    };
    const cb = row.querySelector("input[type=checkbox]");
    if (cb) cb.onclick = (e) => {
      e.stopPropagation();
      cb.checked ? jobsState.selIds.add(j.id) : jobsState.selIds.delete(j.id);
    };
    list.appendChild(row);
  }
}

async function refreshJobs() {
  try {
    const data = await api("/jobs?limit=20");
    renderJobsList(data.items);
    updateJobsBadge(data.items);
  } catch { /* 静默 */ }
}

/** 分页标题显示活动任务数：任务（N）。 */
function updateJobsBadge(items) {
  const tab = $("tabJobs");
  if (!tab) return;
  const active = items.filter((j) => j.status === "queued" || j.status === "running").length;
  tab.textContent = active ? `任务（${active}）` : "任务";
}

/** 轮询：计数徽标常更新；任务分页激活时列表也实时刷新（状态/进度）。 */
async function pollJobs() {
  try {
    const data = await api("/jobs?limit=20");
    updateJobsBadge(data.items);
    const active = document.querySelector("#pane-jobs")?.classList.contains("active");
    if (active) renderJobsList(data.items);
  } catch { /* 静默 */ }
}

function setJobsSelectMode(on) {
  jobsState.selectMode = on;
  jobsState.selIds.clear();
  $("jobsBatchBar").classList.toggle("hidden", !on);
  $("btnJobSelect").classList.toggle("hidden", on);
  refreshJobs();
}

async function batchDeleteJobs() {
  const ids = [...jobsState.selIds];
  if (!ids.length) { toast("请先勾选要删除的任务"); return; }
  if (!confirm(`确定删除选中的 ${ids.length} 个任务？运行中的会被取消。`)) return;
  try {
    const res = await api("/jobs/batch-delete", { method: "POST", body: JSON.stringify({ ids }) });
    toast(res.message);
    jobsState.selIds.clear();
    refreshJobs();
  } catch (e) { toast(e.message); }
}

/* 任务详情弹窗 */
async function openJobModal(jobId) {
  $("jobModal").classList.remove("hidden");
  const body = $("jobModalBody");
  body.innerHTML = "加载中…";
  try {
    const j = await api(`/jobs/${jobId}`);
    const p = j.params || {};
    const imgs = (j.images || []).map((im) =>
      `<div class="result-cell small"><img src="${im.url}" loading="lazy" onclick="window.open('${im.url}','_blank')"></div>`).join("");
    body.innerHTML = `
      <p><span class="badge ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : ""}">${j.status}</span>
         <span class="muted">${fmtTime(j.created_at)}</span> · 进度 ${j.progress}%</p>
      ${j.error ? `<p class="file-missing">${escapeHtml(j.error)}</p>` : ""}
      <p><b>提示词</b>：${escapeHtml(j.prompt || "—")}</p>
      ${j.negative ? `<p><b>负面提示词</b>：${escapeHtml(j.negative)}</p>` : ""}
      <p class="muted">${p.width || "?"}×${p.height || "?"} · ${p.steps || "?"} 步 · 张数 ${j.count ?? p.batch_size ?? 1} · 种子 ${j.seed ?? "?"}${p.mode === "img2img" ? ` · ${p.ref_mode === "edit" ? "智能编辑" : "传统重绘"} · 参考图 ${p.ref_count ?? (p.ref_images?.length ?? 0)} 张` : ""}</p>
      ${imgs ? `<div class="results-grid">${imgs}</div>` : ""}
      <div class="actions"><button class="btn ghost small danger" id="jobModalDelete">🗑 删除任务</button></div>`;
    $("jobModalDelete").onclick = async () => {
      if (!confirm("确定删除该任务？")) return;
      try {
        await api(`/jobs/${jobId}`, { method: "DELETE" });
        toast("已删除");
        $("jobModal").classList.add("hidden");
        refreshJobs();
      } catch (e) { toast(e.message); }
    };
  } catch (e) {
    body.innerHTML = `<p class="file-missing">加载失败：${escapeHtml(e.message)}</p>`;
  }
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

/* ============ 模型管理 ============ */
async function openModels() {
  const modal = $("modelModal");
  modal.classList.remove("hidden");
  const body = $("modelBody");
  body.innerHTML = "加载中…";
  try {
    const data = await api("/models/list");
    if (data.source !== "comfy") {
      body.innerHTML = `<p class="muted">ComfyUI 不可达，无法获取模型列表。请确认 comfy-service 已启动（${"COMFYUI_URL"} 见 .env）。</p>`;
      return;
    }
    const group = (label, items, key) => items.length ? `
      <p><strong>${label}</strong></p>
      <select id="sel-${key}" style="width:100%">
        ${items.map((m) => `<option value="${m.name}" ${m.current ? "selected" : ""}>${m.name}</option>`).join("")}
      </select>` : "";
    body.innerHTML = `
      <p class="muted">列表来自 ComfyUI 实际可见的模型（object_info），选择后写入 .env，下一张图生效。</p>
      ${group("扩散模型", data.items, "transformer")}
      ${group("文本编码器", data.text_encoders, "text-encoder")}
      ${group("VAE", data.vaes, "vae")}
      <div class="actions"><button class="btn btn-primary" id="btnApplyModels">应用选择</button></div>`;
    $("btnApplyModels").onclick = async () => {
      const payload = {};
      for (const [key, field] of [["transformer", "name"], ["text-encoder", "text_encoder"], ["vae", "vae"]]) {
        const sel = $(`sel-${key}`);
        if (sel) payload[field] = sel.value;
      }
      try {
        const res = await api("/models/select", { method: "POST", body: JSON.stringify(payload) });
        toast(res.message || "已切换");
        modal.classList.add("hidden");
      } catch (e) {
        toast("切换失败：" + e.message);
      }
    };
  } catch (e) {
    body.innerHTML = `<p class="muted">加载失败：${e.message}</p>`;
  }
}

/* ============ 提示词管理 ============ */
const promptState = { kind: "prompt", q: "" };

async function openPromptModal() {
  $("promptModal").classList.remove("hidden");
  $("promptSearch").value = "";
  promptState.q = "";
  renderPromptList();
}

async function renderPromptList() {
  const list = $("promptList");
  list.innerHTML = "加载中…";
  try {
    const params = new URLSearchParams({ kind: promptState.kind });
    if (promptState.q) params.set("q", promptState.q);
    const data = await api(`/prompts?${params}`);
    list.innerHTML = "";
    if (!data.items.length) {
      list.innerHTML = '<p class="muted">暂无内容，用上方输入框添加。</p>';
      return;
    }
    for (const p of data.items) {
      const row = document.createElement("div");
      row.className = "prompt-row";
      row.innerHTML = `
        <div class="prompt-text">${escapeHtml(p.text)}</div>
        <span class="muted">用过 ${p.use_count} 次</span>
        <button class="btn ghost small" data-act="replace">替换到输入框</button>
        <button class="btn ghost small" data-act="edit">编辑</button>
        <button class="btn ghost small danger" data-act="del">删除</button>`;
      const setPromptBox = async (text) => {
        // 替换到主界面对应输入框（prompt / negative），并计数
        $(promptState.kind === "prompt" ? "prompt" : "negative").value = text;
        $("promptLen") && ($("promptLen").textContent = $("prompt").value.length);
        await api(`/prompts/${p.id}/use`, { method: "POST" }).catch(() => {});
        toast("已替换到输入框");
        $("promptModal").classList.add("hidden");
      };
      row.querySelector('[data-act=replace]').onclick = () => setPromptBox(p.text);
      row.querySelector('[data-act=del]').onclick = async () => {
        if (!confirm("确定删除该提示词？")) return;
        await api(`/prompts/${p.id}`, { method: "DELETE" });
        renderPromptList();
      };
      row.querySelector('[data-act=edit]').onclick = async () => {
        const text = prompt("修改提示词内容：", p.text);
        if (text === null || !text.trim()) return;
        await api(`/prompts/${p.id}`, { method: "PUT", body: JSON.stringify({ text: text.trim() }) });
        renderPromptList();
      };
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<p class="file-missing">加载失败：${escapeHtml(e.message)}</p>`;
  }
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
  // 图库多选
  $("btnGallerySelect").onclick = () => setGallerySelectMode(true);
  $("btnGalleryCancelSel").onclick = () => setGallerySelectMode(false);
  $("btnGalleryZip").onclick = batchZip;
  $("btnGalleryBatchDel").onclick = batchDeleteGallery;
  // 任务多选
  $("btnJobSelect").onclick = () => setJobsSelectMode(true);
  $("btnJobCancelSel").onclick = () => setJobsSelectMode(false);
  $("btnJobBatchDel").onclick = batchDeleteJobs;
  // 弹窗关闭
  $("imageClose").onclick = () => $("imageModal").classList.add("hidden");
  $("imageModal").onclick = (e) => { if (e.target.id === "imageModal") $("imageModal").classList.add("hidden"); };
  $("jobModalClose").onclick = () => $("jobModal").classList.add("hidden");
  $("jobModal").onclick = (e) => { if (e.target.id === "jobModal") $("jobModal").classList.add("hidden"); };
  $("btnModels").onclick = openModels;
  $("btnPrompts").onclick = openPromptModal;
  $("promptClose").onclick = () => $("promptModal").classList.add("hidden");
  $("promptModal").onclick = (e) => { if (e.target.id === "promptModal") $("promptModal").classList.add("hidden"); };
  els("#promptKindTabs .seg").forEach((btn) => {
    btn.onclick = () => {
      promptState.kind = btn.dataset.kind;
      els("#promptKindTabs .seg").forEach((b) => b.classList.toggle("active", b === btn));
      renderPromptList();
    };
  });
  let promptSearchTimer = null;
  $("promptSearch").addEventListener("input", (e) => {
    clearTimeout(promptSearchTimer);
    promptSearchTimer = setTimeout(() => { promptState.q = e.target.value.trim(); renderPromptList(); }, 260);
  });
  $("promptAdd").onclick = async () => {
    const text = $("promptNewText").value.trim();
    if (!text) { toast("内容不能为空"); return; }
    try {
      await api("/prompts", { method: "POST", body: JSON.stringify({ kind: promptState.kind, text }) });
      $("promptNewText").value = "";
      toast("已保存");
      renderPromptList();
    } catch (e) { toast("保存失败：" + e.message); }
  };
  $("modelClose").onclick = () => $("modelModal").classList.add("hidden");
  $("modelModal").onclick = (e) => { if (e.target.id === "modelModal") $("modelModal").classList.add("hidden"); };
}

renderRefStrip();
bindEvents();
scheduleEstimate();
refreshStatus();
refreshGallery();
setInterval(refreshStatus, 15000);
setInterval(pollJobs, 3000);
pollJobs();
