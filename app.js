const $ = (id) => document.getElementById(id);

const DEFAULT_PART_MIB = 7.5;           // Discord-safe
const PART_BYTES = Math.floor(DEFAULT_PART_MIB * 1024 * 1024);

let selectedFileId = null;

function log(msg) {
  $("log").textContent += msg + "\n";
  $("log").scrollTop = $("log").scrollHeight;
}
function status(msg) { $("status").textContent = msg; }

function base() {
  const u = $("workerUrl").value.trim().replace(/\/+$/, "");
  if (!u) throw new Error("Set Worker URL");
  return u;
}

function headers(extra = {}) {
  const h = { ...extra };
  const k = $("apiKey").value.trim();
  if (k) h["X-API-Key"] = k;
  return h;
}

function loadSettings() {
  const s = JSON.parse(localStorage.getItem("cc_settings") || "{}");
  $("workerUrl").value = s.workerUrl || "";
  $("apiKey").value = s.apiKey || "";
}

function saveSettings() {
  localStorage.setItem("cc_settings", JSON.stringify({
    workerUrl: $("workerUrl").value.trim(),
    apiKey: $("apiKey").value
  }));
  log("Saved settings.");
}

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function fileIdFor(filename, hashHex) {
  const safe = filename
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "");
  return `${safe}:${hashHex.slice(0, 12)}`;
}

async function apiList() {
  const r = await fetch(`${base()}/api/list`, { headers: headers() });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}

function renderList(idx) {
  const tbody = $("tbody");
  tbody.innerHTML = "";
  selectedFileId = null;
  $("download").disabled = true;
  $("del").disabled = true;

  const files = idx.files || {};
  for (const [fid, rec] of Object.entries(files)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${rec.original_filename}</td>
      <td>${(rec.parts || []).filter(Boolean).length}/${rec.total_parts}</td>
      <td>${rec.complete ? "yes" : "no"}</td>
      <td><code>${fid}</code></td>
    `;
    tr.onclick = () => {
      [...tbody.querySelectorAll("tr")].forEach(x => x.classList.remove("sel"));
      tr.classList.add("sel");
      selectedFileId = fid;
      $("download").disabled = false;
      $("del").disabled = false;
    };
    tbody.appendChild(tr);
  }
}

async function refresh() {
  status("Refreshing…");
  const idx = await apiList();
  renderList(idx);
  status(`Loaded ${Object.keys(idx.files || {}).length} files.`);
}

async function upload() {
  const f = $("file").files?.[0];
  if (!f) return;

  $("prog").value = 0;
  status("Hashing…");
  log(`Selected: ${f.name} (${f.size} bytes)`);

  // Stable id: hash full file once
  const fullHash = await sha256Hex(f);
  const fid = fileIdFor(f.name, fullHash);

  const totalParts = Math.ceil(f.size / PART_BYTES);
  log(`file_id=${fid} parts=${totalParts} part_bytes=${PART_BYTES}`);

  for (let i = 1; i <= totalParts; i++) {
    const start = (i - 1) * PART_BYTES;
    const end = Math.min(i * PART_BYTES, f.size);
    const chunk = f.slice(start, end);

    status(`Uploading part ${i}/${totalParts}…`);

    const fd = new FormData();
    fd.append("file_id", fid);
    fd.append("filename", f.name);
    fd.append("part_no", String(i));
    fd.append("total_parts", String(totalParts));
    fd.append("blob", chunk, `${f.name}.part${String(i).padStart(4, "0")}`);

    const r = await fetch(`${base()}/api/upload-part`, {
      method: "POST",
      headers: headers(), // DO NOT set content-type for multipart
      body: fd
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Upload failed part ${i}: ${JSON.stringify(j)}`);

    $("prog").value = Math.floor((i / totalParts) * 100);

    // gentle pacing to reduce Discord rate-limit pain
    await new Promise(res => setTimeout(res, 900));
  }

  status("Upload complete. Refreshing…");
  await refresh();
  $("prog").value = 0;
}

async function downloadSelected() {
  if (!selectedFileId) return;
  status("Downloading…");

  const r = await fetch(`${base()}/api/download?file_id=${encodeURIComponent(selectedFileId)}`, {
    headers: headers()
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(t);
  }

  const blob = await r.blob();
  const cd = r.headers.get("content-disposition") || "";
  const m = /filename="([^"]+)"/.exec(cd);
  const name = m ? m[1] : "download.bin";

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);

  status("Download started.");
}

async function deleteSelected() {
  if (!selectedFileId) return;
  if (!confirm(`Delete ${selectedFileId}?`)) return;

  status("Deleting…");
  const r = await fetch(`${base()}/api/delete?file_id=${encodeURIComponent(selectedFileId)}`, {
    method: "POST",
    headers: headers()
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(j));

  log(`Deleted messages best-effort: ${j.deleted_messages}`);
  await refresh();
}

$("save").onclick = saveSettings;
$("refresh").onclick = () => refresh().catch(e => log(String(e)));
$("upload").onclick = () => upload().catch(e => { log(String(e)); status("Upload failed."); });
$("download").onclick = () => downloadSelected().catch(e => { log(String(e)); status("Download failed."); });
$("del").onclick = () => deleteSelected().catch(e => { log(String(e)); status("Delete failed."); });

loadSettings();
