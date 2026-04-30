const state = {
  starts: [],
  destinations: [],
  bindings: [],
  hotspotsCache: new Map(),
  mapAvailabilityCache: new Map(),
  fileMode: location.protocol === "file:",
};

// Closed points: hidden from both start and destination selectors.
const CLOSED_POINT_IDS = new Set([
  "f5_nw_stair",
  "f5_sw_stair",
  "f5_s_stair_w",
  "f5_ne_stair",
]);

const $ = (id) => document.getElementById(id);
const startSelect = $("startSelect");
const destSelect = $("destSelect");
const queryBtn = $("queryBtn");
const routeTitle = $("routeTitle");
const previewPanel = $("previewPanel");
const stage = $("stage");
const empty = $("empty");
const floorImg = $("floorImg");
const overlay = $("overlay");
const zoomBtn = $("zoomBtn");
const zoomModal = $("zoomModal");
const zoomClose = $("zoomClose");
const zoomImg = $("zoomImg");
const zoomOverlay = $("zoomOverlay");
const zoomStage = $("zoomStage");
const photoModal = $("photoModal");
const photoClose = $("photoClose");
const photoImg = $("photoImg");
const photoStage = $("photoStage");

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = cols[i] ?? ""));
    return row;
  });
}

async function loadCsv(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`加载失败: ${url} (HTTP ${res.status})`);
  return parseCsv(await res.text());
}

function fillSelect(el, options, valueKey, labelKey, selected) {
  el.innerHTML = options
    .map((o) => `<option value="${esc(o[valueKey])}">${esc(o[labelKey])}</option>`)
    .join("");
  if (selected && options.some((o) => o[valueKey] === selected)) {
    el.value = selected;
  }
}

function normalizeMapName(mapNameRaw) {
  return String(mapNameRaw || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function mapImagePath(mapNameRaw) {
  const mapName = normalizeMapName(mapNameRaw);
  return `maps/${mapName}.png`;
}

function getStartById(startId) {
  return state.starts.find((s) => s.start_id === startId) || null;
}

function getDestinationById(destId) {
  return state.destinations.find((d) => d.destination_id === destId) || null;
}

function isBindingStructurallyUsable(binding) {
  if (!binding) return false;
  const startId = (binding.start_id || "").trim();
  const destId = (binding.destination_id || "").trim();
  const mapName = normalizeMapName((binding.map_name || "").trim());
  if (!startId || !destId || !mapName) return false;
  if (startId === destId) return false;
  if (CLOSED_POINT_IDS.has(startId) || CLOSED_POINT_IDS.has(destId)) return false;
  if (!getStartById(startId)) return false;
  if (!getDestinationById(destId)) return false;
  return true;
}

async function ensureMapAvailable(mapNameRaw) {
  const mapName = normalizeMapName(mapNameRaw);
  if (!mapName) return false;
  if (state.mapAvailabilityCache.has(mapName)) return state.mapAvailabilityCache.get(mapName);

  const ok = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = mapImagePath(mapName);
  });

  state.mapAvailabilityCache.set(mapName, ok);
  return ok;
}

function getCandidateBindingsForStart(startId) {
  return state.bindings.filter(
    (b) => isBindingStructurallyUsable(b) && b.start_id === startId,
  );
}

async function getUsableBindingsForStart(startId, { verifyMap = true } = {}) {
  const candidates = getCandidateBindingsForStart(startId);
  if (!verifyMap) return candidates;

  const checks = await Promise.all(
    candidates.map(async (b) => ({ b, ok: await ensureMapAvailable(b.map_name) })),
  );

  return checks.filter((x) => x.ok).map((x) => x.b);
}

async function getDestinationsForStart(startId, options) {
  const bindings = await getUsableBindingsForStart(startId, options);
  const destIds = new Set(bindings.map((b) => b.destination_id));
  return state.destinations
    .filter((d) => destIds.has(d.destination_id))
    .sort((a, b) => a.destination_name.localeCompare(b.destination_name, "zh-CN"));
}

async function syncDestinations(options) {
  const list = await getDestinationsForStart(startSelect.value, options);
  fillSelect(destSelect, list, "destination_id", "destination_name");
}

async function pickBinding(startId, destId) {
  // Only validate the selected route map on demand, instead of probing all
  // maps under the same start point during the first query.
  const binding = getCandidateBindingsForStart(startId).find((b) => b.destination_id === destId) || null;
  if (!binding) return null;
  const ok = await ensureMapAvailable(binding.map_name);
  return ok ? binding : null;
}

async function getHotspotsByMapName(mapNameRaw) {
  const mapName = normalizeMapName(mapNameRaw);
  const cacheKey = mapName;
  if (state.hotspotsCache.has(cacheKey)) return state.hotspotsCache.get(cacheKey);

  if (state.fileMode && window.NAV_DATA?.hotspots) {
    const direct = window.NAV_DATA.hotspots[mapName];
    const base = window.NAV_DATA.hotspots[mapName.split("/").pop()];
    const rows = direct || base;
    if (rows) {
      state.hotspotsCache.set(cacheKey, rows);
      return rows;
    }
  }

  try {
    const rows = await loadCsv(`data/hotspots/${mapName}.csv`);
    state.hotspotsCache.set(cacheKey, rows);
    return rows;
  } catch {
    try {
      const base = mapName.split("/").pop();
      const rows = await loadCsv(`data/hotspots/${base}.csv`);
      state.hotspotsCache.set(cacheKey, rows);
      return rows;
    } catch {
      state.hotspotsCache.set(cacheKey, []);
      return [];
    }
  }
}

function getHeatHotspotsByMapName(mapNameRaw) {
  const mapName = normalizeMapName(mapNameRaw);
  const base = mapName.split("/").pop();
  const rows = window.HEAT_DATA?.[mapName] || window.HEAT_DATA?.[base] || [];
  return rows.map((p, idx) => ({
    label: p.label || `热点 ${idx + 1}`,
    x: Number(p.x),
    y: Number(p.y),
    photo: p.photo || "",
    photo_url: p.photo_url || "",
  })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function renderRoutePath(pathSvg, hotspots) {
  const circles = hotspots
    .map((p, idx) => {
      const endClass = idx === hotspots.length - 1 ? " end" : "";
      const label = p.label || String(idx + 1);
      const photoUrl = p.photo_url || "";
      return `<circle class="route-dot${endClass}" cx="${Number(p.x)}" cy="${Number(p.y)}" r="6" data-photo-url="${esc(photoUrl)}" data-label="${esc(label)}"></circle><text class="route-label" x="${Number(p.x)}" y="${Number(p.y) + 1}">${esc(label)}</text>`;
    })
    .join("");
  overlay.innerHTML = `<path class="route-line" d="${esc(pathSvg || "")}"></path>${circles}`;
}

function openPhotoModal(photoUrl, label) {
  if (!photoUrl) return;
  photoImg.src = photoUrl;
  photoImg.alt = label ? `${label}实景图` : "热点实景图";
  photoModal.classList.remove("hidden");
  document.body.classList.add("photo-open");
  if (photoImg.complete) requestAnimationFrame(updatePhotoScale);
}

function closePhotoModal() {
  photoModal.classList.add("hidden");
  document.body.classList.remove("photo-open");
}

function updatePhotoScale() {
  if (photoModal.classList.contains("hidden")) return;
  const naturalWidth = photoImg.naturalWidth || 1080;
  const naturalHeight = photoImg.naturalHeight || 1440;
  const closeReserve = 64;
  const padding = 20;
  const availableWidth = Math.max(240, window.innerWidth - padding);
  const availableHeight = Math.max(240, window.innerHeight - closeReserve - padding);
  const scale = Math.min(availableWidth / naturalHeight, availableHeight / naturalWidth, 1);
  photoStage.style.setProperty("--photo-img-width", `${naturalWidth}px`);
  photoStage.style.setProperty("--photo-scale", String(scale));
}

function handleHotspotClick(e) {
  const dot = e.target.closest?.(".route-dot");
  if (!dot) return;
  const photoUrl = dot.dataset.photoUrl || "";
  if (!photoUrl) return;
  e.stopPropagation();
  openPhotoModal(photoUrl, dot.dataset.label || "");
}

function openZoomModal() {
  if (!floorImg.src || stage.classList.contains("hidden")) return;
  zoomImg.src = floorImg.src;
  zoomOverlay.innerHTML = overlay.innerHTML;
  zoomModal.classList.remove("hidden");
  document.body.classList.add("zoom-open");
  requestAnimationFrame(updateZoomScale);
}

function closeZoomModal() {
  closePhotoModal();
  zoomModal.classList.add("hidden");
  document.body.classList.remove("zoom-open");
}

function updateZoomScale() {
  if (zoomModal.classList.contains("hidden")) return;
  const naturalWidth = floorImg.naturalWidth || 1086;
  const naturalHeight = floorImg.naturalHeight || 768;
  const closeReserve = 64;
  const padding = 20;
  const availableWidth = Math.max(240, window.innerWidth - padding);
  const availableHeight = Math.max(240, window.innerHeight - closeReserve - padding);
  const scale = Math.min(availableWidth / naturalHeight, availableHeight / naturalWidth, 1);
  zoomStage.style.setProperty("--zoom-img-width", `${naturalWidth}px`);
  zoomStage.style.setProperty("--zoom-scale", String(scale));
}

async function renderBySelection() {
  const startId = startSelect.value;
  const destId = destSelect.value;

  if (!startId || !destId) {
    previewPanel.classList.add("hidden");
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    routeTitle.textContent = "路线预览";
    empty.textContent = "请选择起点和终点。";
    return;
  }

  if (startId === destId) {
    previewPanel.classList.add("hidden");
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    routeTitle.textContent = "路线预览";
    empty.textContent = "起点和终点不能相同，请重新选择。";
    return;
  }

  if (CLOSED_POINT_IDS.has(startId) || CLOSED_POINT_IDS.has(destId)) {
    previewPanel.classList.add("hidden");
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    routeTitle.textContent = "路线预览";
    empty.textContent = "该点位当前关闭，不提供导览。";
    return;
  }

  const binding = await pickBinding(startId, destId);
  if (!binding) {
    previewPanel.classList.add("hidden");
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    routeTitle.textContent = "路线预览";
    empty.textContent = "未找到该起点/终点的有效路线（含地图文件），请检查 data/route-bindings.csv 与 maps 目录。";
    return;
  }

  const mapName = normalizeMapName((binding.map_name || "").trim());
  floorImg.src = mapImagePath(mapName);

  const heatHotspots = getHeatHotspotsByMapName(mapName);
  const hotspotRows = await getHotspotsByMapName(mapName);
  const routeHotspots = heatHotspots.length ? heatHotspots : hotspotRows
    .filter((h) => h.route_id === binding.route_id)
    .sort((a, b) => Number(a.order_no || 0) - Number(b.order_no || 0));

  renderRoutePath(binding.path_svg, routeHotspots);
  const startName = getStartById(startId)?.start_name || startId;
  const destName = getDestinationById(destId)?.destination_name || destId;
  routeTitle.textContent = `${startName} -> ${destName}`;
  previewPanel.classList.remove("hidden");
  stage.classList.remove("hidden");
  empty.classList.add("hidden");
}

function loadFromEmbedded() {
  const d = window.NAV_DATA;
  if (!d) throw new Error("缺少 data/nav-data.js，无法在本地文件模式读取数据。", { cause: null });
  state.starts = d.starts || [];
  state.destinations = d.destinations || [];
  state.bindings = d.bindings || [];
}

function getAvailableStarts() {
  const startIds = new Set();
  for (const binding of state.bindings) {
    if (!isBindingStructurallyUsable(binding)) continue;
    startIds.add(binding.start_id);
  }

  return state.starts.filter((s) => startIds.has(s.start_id));
}

async function init() {
  if (window.NAV_DATA) {
    loadFromEmbedded();
  } else {
    state.starts = await loadCsv("data/starts.csv");
    state.destinations = await loadCsv("data/destinations.csv");
    state.bindings = await loadCsv("data/route-bindings.csv");
  }

  const availableStarts = getAvailableStarts();
  fillSelect(startSelect, availableStarts, "start_id", "start_name");

  const q = new URLSearchParams(location.search);
  const qStart = q.get("start") || "";
  const qDest = q.get("dest") || "";
  if (qStart && availableStarts.some((s) => s.start_id === qStart)) {
    startSelect.value = qStart;
  }

  await syncDestinations({ verifyMap: false });
  if (qDest) {
    const list = await getDestinationsForStart(startSelect.value, { verifyMap: false });
    if (list.some((d) => d.destination_id === qDest)) {
      destSelect.value = qDest;
    }
  }
}

startSelect.addEventListener("change", async () => {
  await syncDestinations({ verifyMap: false });
  previewPanel.classList.add("hidden");
  stage.classList.add("hidden");
  empty.classList.remove("hidden");
  empty.textContent = "请选择终点后点击“查看路线”。";
});

zoomBtn.addEventListener("click", openZoomModal);
zoomClose.addEventListener("click", closeZoomModal);
zoomModal.addEventListener("click", (e) => {
  if (e.target === zoomModal) closeZoomModal();
});
overlay.addEventListener("click", handleHotspotClick);
zoomOverlay.addEventListener("click", handleHotspotClick);
photoClose.addEventListener("click", closePhotoModal);
photoModal.addEventListener("click", (e) => {
  if (e.target === photoModal) closePhotoModal();
});
window.addEventListener("resize", updateZoomScale);
window.addEventListener("resize", updatePhotoScale);
photoImg.addEventListener("load", updatePhotoScale);

queryBtn.addEventListener("click", async () => {
  try {
    await renderBySelection();
  } catch (e) {
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = e.message;
  }
});

init().then(() => {
  previewPanel.classList.add("hidden");
  stage.classList.add("hidden");
  empty.classList.remove("hidden");
  empty.textContent = "请选择起点和终点后点击“查看路线”。";
}).catch((e) => {
  stage.classList.add("hidden");
  empty.classList.remove("hidden");
  empty.textContent = e.message;
});
