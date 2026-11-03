const TITLES = {
  dashboard: "Maison",
  devices: "Appareils",
  scan: "Ajouter",
  settings: "Réglages",
};

const STATE_LABEL = {
  online: "Ça répond",
  offline: "Pas de réponse",
  degraded: "Répond mal",
  unknown: "Pas encore vérifié",
};

const SOURCE = {
  manuel: "modifiée dans la console",
  detection: "repérée sur le réseau",
  suivi: "suivie après redémarrage",
  creation: "première adresse",
};

const PROTOCOLS = [
  ["ping", "Vérifier qu'il est là"],
  ["http", "Page de l'appareil"],
  ["https", "Page sécurisée"],
  ["rtsp", "Caméra"],
  ["tcp", "Autre branchement"],
];

const RELEASE = "https://github.com/dariohd/maMaison/releases/latest/download/maMaisonConnectee.exe";

const state = {
  view: "dashboard",
  devices: [],
  types: [],
  rooms: [],
  settings: null,
  network: null,
  dashboard: null,
  scan: null,
  dashKey: "",
  dashStatus: "all",
  deviceQuery: "",
  deviceType: "",
  deviceRoom: "",
  deviceStatus: "",
  scanDraft: null,
  scanDeep: false,
  modal: null,
  scanning: false,
  viewer: null,
  viewerTimer: null,
  presets: [],
  pickHouse: false,
  pending: new Set(),
};

const viewEl = () => document.getElementById("view");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_err) {
      data = null;
    }
  }
  if (!response.ok) {
    let detail = data && data.detail;
    if (Array.isArray(detail)) detail = "Certains champs sont invalides.";
    const error = new Error(detail || "La requête a échoué.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.hidden = !message;
  el.textContent = message || "";
  if (message) {
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }
}

function subnetDefault() {
  return state.settings?.subnet || state.network?.suggested_subnet || "";
}

function ago(iso) {
  if (!iso) return "pas encore";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const seconds = Math.round((Date.now() - when.getTime()) / 1000);
  if (seconds < 15) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `il y a ${hours} h`;
  return when.toLocaleString("fr-FR");
}

function linkLabel(device) {
  const protocol = (device.protocol || "ping").toUpperCase();
  if (device.protocol === "ping" || !device.port) return protocol === "PING" ? "Ping" : protocol;
  return `${protocol} ${device.port}`;
}

function statusText(device) {
  return STATE_LABEL[device.state] || STATE_LABEL.unknown;
}

function options(items, selected, emptyLabel) {
  const parts = [];
  if (emptyLabel !== undefined) parts.push(`<option value="">${esc(emptyLabel)}</option>`);
  for (const item of items) {
    const selectedAttr = String(item.id) === String(selected ?? "") ? " selected" : "";
    parts.push(`<option value="${item.id}"${selectedAttr}>${esc(item.name)}</option>`);
  }
  return parts.join("");
}

function protocolOptions(selected) {
  return PROTOCOLS.map(([value, label]) => {
    const selectedAttr = value === selected ? " selected" : "";
    return `<option value="${value}"${selectedAttr}>${esc(label)}</option>`;
  }).join("");
}

function typeIdByName(name) {
  const found = state.types.find((item) => item.name.toLowerCase() === String(name || "").toLowerCase());
  if (found) return found.id;
  const other = state.types.find((item) => item.name.toLowerCase() === "autre");
  return (other || state.types[0] || {}).id || "";
}

function paintChrome() {
  document.body.classList.toggle("is-phone", !onHouseComputer());
  document.body.classList.toggle("is-setup", state.view === "link" || state.view === "login" || state.view === "install");
  document.querySelectorAll(".nav[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  document.getElementById("view-title").textContent = TITLES[state.view] || "maMaisonConnectee";
  const eyebrow = document.getElementById("eyebrow");
  const meta = document.getElementById("top-meta");
  if (eyebrow) eyebrow.hidden = true;
  if (meta) {
    meta.hidden = true;
    meta.textContent = "";
  }
}

function commandKey(deviceId, actionId) {
  return `${deviceId}:${actionId}`;
}

function commandOutcome(result) {
  if (!result) return "C'est envoyé.";
  const detail = String(result.detail || "");
  if (/fenêtre|ordinateur de la maison|n'a pas répondu/i.test(detail) && result.ok !== true && !/HTTP/.test(detail)) {
    return "La maison ne répond pas. Allume l'ordinateur où le programme est ouvert.";
  }
  if (/injoignable/i.test(detail)) return "L'appareil ne répond pas.";
  if (result.ok === false || /HTTP [45]/.test(detail) || /échoué/i.test(detail)) {
    return "Ça n'a pas marché.";
  }
  if (result.ok === true || /HTTP [23]/.test(detail)) return "C'est fait.";
  return detail || "C'est envoyé.";
}

function runButton(device, item, prominent) {
  const waiting = state.pending.has(commandKey(device.id, item.id));
  const cls = prominent ? "btn primary" : "btn";
  return `<button type="button" class="${cls}" data-action="run-action" data-id="${device.id}" data-command="${item.id}" ${waiting ? "disabled" : ""}>${esc(waiting ? "En cours" : item.label)}</button>`;
}

function streamButton(device, item) {
  return `<button type="button" class="btn" data-action="show-stream" data-id="${device.id}" data-command="${item.id}" data-method="${esc(item.method)}" data-label="${esc(item.label)}">${esc(item.label)}</button>`;
}

function dailyCard(device) {
  const actions = device.actions || [];
  const calls = actions.filter((item) => item.kind !== "stream");
  const streams = actions.filter((item) => item.kind === "stream");
  const buttons = [
    calls[0] ? runButton(device, calls[0], true) : "",
    ...calls.slice(1).map((item) => runButton(device, item, false)),
    ...streams.map((item) => streamButton(device, item)),
  ].filter(Boolean).join("");
  const conflict = device.ip_conflict ? `<span class="badge warn">Même adresse qu'un autre</span>` : "";
  const empty = onHouseComputer()
    ? `<p class="quiet">Pas de bouton. Ouvre la fiche pour en ajouter.</p>`
    : `<p class="quiet">Pas de bouton.</p>`;
  return `
    <article class="device-card">
      <button type="button" class="name-btn" data-action="open-device" data-id="${device.id}">
        <span class="name-line"><i class="dot ${esc(device.state || "unknown")}"></i> ${esc(device.name)}${conflict}</span>
        <span class="sub">${esc(device.type_name || "Appareil")} · ${esc(statusText(device))}</span>
      </button>
      ${buttons ? `<div class="actions">${buttons}</div>` : empty}
    </article>
  `;
}

function roomsOf(devices) {
  const order = new Map((state.rooms || []).map((room) => [room.name, room.sort_order ?? 0]));
  const groups = new Map();
  for (const device of devices) {
    const name = device.room_name || "Non classé";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(device);
  }
  return [...groups.keys()].sort((a, b) => {
    if (a === "Non classé") return 1;
    if (b === "Non classé") return -1;
    const gap = (order.get(a) ?? 1000) - (order.get(b) ?? 1000);
    if (gap) return gap;
    return a.localeCompare(b, "fr");
  }).map((name) => ({ name, devices: groups.get(name) }));
}

function deviceRow(device) {
  const room = device.room_name || "Sans pièce";
  const conflict = device.ip_conflict ? `<span class="badge warn">Même adresse qu'un autre</span>` : "";
  return `
    <article class="row static row-lite">
      <i class="dot ${esc(device.state || "unknown")}"></i>
      <button type="button" class="name-btn" data-action="open-device" data-id="${device.id}">
        <strong>${esc(device.name)}${conflict}</strong>
        <span class="sub">${esc(device.type_name || "Appareil")}</span>
      </button>
      <span>${esc(room)}</span>
      <span class="state-${esc(device.state || "unknown")}">${esc(statusText(device))}</span>
    </article>
  `;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) {
    viewEl().innerHTML = `<p class="empty">Chargement.</p>`;
    return;
  }
  const counts = data.counts || {};
  const house = data.house;
  const houseNote = house && !house.online
    ? `<p class="house-note">La maison ne répond pas. Allume l'ordinateur où maMaisonConnectee est installé, et laisse le programme ouvert.</p>`
    : "";
  const unsure = (counts.degraded || 0) + (counts.unknown || 0);
  const devices = data.devices || [];
  const chips = [
    ["all", "Tous"],
    ["problem", "Sans réponse"],
  ].map(([value, label]) => `
    <button type="button" class="chip${state.dashStatus === value ? " is-on" : ""}" data-action="dash-filter" data-status="${value}">${label}</button>
  `).join("");
  const visible = devices.filter((device) => {
    if (state.dashStatus === "problem") return device.state === "offline" || device.state === "degraded";
    return state.dashStatus === "all" || device.state === state.dashStatus;
  });
  const rooms = roomsOf(visible);
  viewEl().innerHTML = `
    ${houseNote}
    <section class="stats">
      <article class="stat"><span>Appareils</span><b>${counts.total || 0}</b></article>
      <article class="stat online"><span>Ça répond</span><b>${counts.online || 0}</b></article>
      <article class="stat offline"><span>Sans réponse</span><b>${counts.offline || 0}</b></article>
      <article class="stat partial"><span>À vérifier</span><b>${unsure}</b></article>
    </section>
    ${counts.total ? "" : `<p class="empty">${onHouseComputer() ? "Aucun appareil pour l'instant. Cherche ceux du Wi-Fi, puis donne-leur un nom et une pièce." : "Aucun appareil pour l'instant. La recherche se fait sur l'ordinateur de la maison."}</p>`}
    ${counts.total ? `
      <div class="section-head">
        <h2>Pièces</h2>
        <div class="chips">${chips}</div>
        ${onHouseComputer() ? `<button type="button" class="btn" data-action="nav" data-view="scan">Chercher</button>` : ""}
      </div>
      <div class="stack">
        ${rooms.length ? rooms.map((room) => `
          <section class="room-block">
            <h3>${esc(room.name === "Non classé" ? "Sans pièce" : room.name)} <span>${room.devices.length}</span></h3>
            <div class="device-cards">${room.devices.map((device) => dailyCard(device)).join("")}</div>
          </section>
        `).join("") : `<p class="quiet">Tout répond.</p>`}
      </div>
    ` : ""}
  `;
}

function filteredDevices() {
  const query = state.deviceQuery.trim().toLowerCase();
  return state.devices.filter((device) => {
    if (state.deviceType && String(device.type_id) !== String(state.deviceType)) return false;
    if (state.deviceRoom && String(device.room_id || "") !== String(state.deviceRoom)) return false;
    if (state.deviceStatus && device.state !== state.deviceStatus) return false;
    if (!query) return true;
    const blob = [device.name, device.ip, device.mac, device.hostname, device.type_name, device.room_name, device.notes]
      .join(" ")
      .toLowerCase();
    return blob.includes(query);
  });
}

function renderDevices() {
  const rows = filteredDevices();
  viewEl().innerHTML = `
    <div class="toolbar">
      <input id="q" class="grow" placeholder="Nom ou pièce" value="${esc(state.deviceQuery)}">
      <select id="f-type">${options(state.types, state.deviceType, "Tous les types")}</select>
      <select id="f-room">${options(state.rooms, state.deviceRoom, "Toutes les pièces")}</select>
      <select id="f-status">
        <option value="">Tous</option>
        ${["online", "offline", "degraded", "unknown"].map((value) => `<option value="${value}"${state.deviceStatus === value ? " selected" : ""}>${STATE_LABEL[value]}</option>`).join("")}
      </select>
      ${onHouseComputer() ? `<button type="button" class="btn primary" data-action="add-device">Ajouter</button>` : ""}
    </div>
    <div class="list" id="device-rows">
      ${rows.length ? rows.map((device) => deviceRow(device)).join("") : `<p class="empty">Aucun appareil. ${onHouseComputer() ? "Cherche-les dans Ajouter, ou crée-en un." : "Ils apparaîtront quand l'ordinateur de la maison les aura enregistrés."}</p>`}
    </div>
  `;
}

function hostEstimate(cidr) {
  const match = /^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/.exec((cidr || "").trim());
  if (!match) return null;
  const bits = Number(match[2]);
  if (bits < 22 || bits > 32) return null;
  if (bits >= 31) return 2 ** (32 - bits);
  return (2 ** (32 - bits)) - 2;
}

function scanHints(item) {
  const bits = [];
  if (item.answered_ping) {
    bits.push(item.latency_ms != null ? `ping ${item.latency_ms} ms` : "répond au ping");
  } else {
    bits.push("pas de réponse au ping");
  }
  if (item.open_ports && item.open_ports.length) bits.push(`ports ${item.open_ports.join(", ")}`);
  if (item.mac) bits.push(item.mac);
  else bits.push("MAC inconnue");
  if (item.is_gateway) bits.push("passerelle");
  if (item.is_self) bits.push("cet ordinateur");
  return bits.join(" · ");
}

function renderScan() {
  const scan = state.scan;
  const subnet = state.scanDraft ?? subnetDefault();
  const estimate = hostEstimate(subnet);
  const running = scan && scan.state === "running";
  const phase = "Recherche";
  const width = running && scan.total ? Math.min(100, Math.round((scan.done / scan.total) * 100)) : 0;
  let body = "";
  if (scan && scan.state === "error") {
    body = `<p class="form-error">${esc(scan.error || "L'analyse a échoué.")}</p>`;
  }
  if (scan && (scan.state === "done" || scan.state === "cancelled")) {
    body = renderScanResults(scan);
  }
  const others = (state.network?.adapters || []).filter((item) => item.subnet && item.subnet !== state.network?.suggested_subnet);
  viewEl().innerHTML = `
    <form id="scan-form" class="card stack" data-form="scan">
      <p>Cherche les appareils du Wi-Fi, coche ceux de la maison, donne-leur un nom et une pièce.</p>
      ${state.network?.suggested_subnet ? "" : `<p>Branche cet ordinateur au Wi-Fi de la maison.</p>`}
      <div class="actions">
        <button class="btn primary" type="submit" ${running ? "disabled" : ""}>Chercher</button>
        ${running ? `<button class="btn" type="button" data-action="cancel-scan">Arrêter</button>` : ""}
      </div>
      <details>
        <summary>Si la recherche ne vise pas le bon Wi-Fi</summary>
        <div class="stack">
          <label>Wi-Fi à chercher
            <input id="subnet" name="subnet" class="mono" value="${esc(subnet)}" spellcheck="false" autocomplete="off" ${running ? "disabled" : ""}>
          </label>
          <label class="line"><input id="deep" type="checkbox" ${state.scanDeep ? "checked" : ""} ${running ? "disabled" : ""}> Chercher aussi les appareils discrets. C'est plus long.</label>
          <p class="quiet" id="estimate">${estimate == null ? "Par exemple 192.168.1.0/24." : "Compte une à deux minutes."}</p>
          <button class="btn" type="button" data-action="use-suggested" ${running ? "disabled" : ""}>Reprendre le Wi-Fi de cet ordinateur</button>
        </div>
      </details>
      ${running ? `<div><p>${esc(phase)}, ${scan.done} sur ${scan.total}. ${scan.responding || 0} trouvé${scan.responding > 1 ? "s" : ""}.</p><div class="progress"><span style="width:${width}%"></span></div></div>` : ""}
      ${scan && scan.state === "cancelled" ? `<p class="quiet">Recherche arrêtée. Voici ce qui a déjà été vu.</p>` : ""}
    </form>
    ${body}
    ${others.length ? `<details><summary>Autres Wi-Fi de cet ordinateur</summary><div class="list">${others.map((item) => `<p>${esc(item.name)}</p>`).join("")}</div></details>` : ""}
  `;
}

function renderScanResults(scan) {
  const changed = scan.changed || [];
  const fresh = scan.new || [];
  const conflicts = scan.conflicts || [];
  const known = scan.known || [];
  return `
    <section class="stack" style="margin-top:18px">
      <div class="toolbar">
        <button type="button" class="btn primary" data-action="apply-scan">Garder la sélection</button>
        <button type="button" class="btn" data-action="check-new">Cocher les nouveaux</button>
      </div>
      ${changed.length ? `<h2>Adresse changée</h2><div class="list">${changed.map(renderChanged).join("")}</div>` : ""}
      ${conflicts.length ? `<h2>À corriger</h2><div class="list">${conflicts.map(renderConflict).join("")}</div>` : ""}
      <h2>Nouveaux</h2>
      ${fresh.length ? `<div class="list">${fresh.map(renderFresh).join("")}</div>` : `<p class="quiet">Rien de nouveau.</p>`}
      <details>
        <summary>Déjà dans la maison (${known.length})</summary>
        <div class="list">${known.map((item) => `<p><strong>${esc(item.device_name)}</strong></p>`).join("") || `<p class="quiet">Aucun.</p>`}</div>
      </details>
    </section>
  `;
}

function renderChanged(item) {
  return `
    <article class="scan-card" data-change-row data-id="${item.device_id}" data-ip="${esc(item.ip)}" data-mac="${esc(item.mac || "")}" data-hostname="${esc(item.hostname || "")}">
      <header>
        <label class="line"><input class="pick" type="checkbox" checked> <strong>${esc(item.device_name)}</strong></label>
        <span>Adresse mise à jour</span>
      </header>
      <p class="quiet">Avant ${esc(item.previous_ip)}, maintenant ${esc(item.ip)}.</p>
    </article>
  `;
}

function renderConflict(item) {
  return `
    <article class="scan-card">
      <header>
        <strong>${esc(item.device_name)}</strong>
        <span>même adresse</span>
      </header>
      <p class="quiet">Deux appareils utilisent ${esc(item.ip)}. Laisse cette ligne de côté, ou corrige la fiche.</p>
    </article>
  `;
}

function renderFresh(item) {
  const protocol = item.suggested_protocol || "ping";
  const port = item.suggested_port || "";
  const name = item.hostname || `Appareil ${item.ip}`;
  return `
    <article class="scan-card" data-new-row data-ip="${esc(item.ip)}" data-mac="${esc(item.mac || "")}" data-hostname="${esc(item.hostname || "")}">
      <header>
        <label class="line"><input class="pick" type="checkbox"> Adresse ${esc(item.ip)}</label>
        ${item.is_self ? `<span class="badge">Cet ordinateur</span>` : ""}
        ${item.is_gateway ? `<span class="badge">La box</span>` : ""}
      </header>
      <div class="grid-3">
        <label>Nom <input class="name" value="${esc(name)}"></label>
        <label>Type <select class="type">${options(state.types, typeIdByName(item.suggested_type))}</select></label>
        <label>Pièce <select class="room">${options(state.rooms, "", "Sans pièce")}</select></label>
      </div>
      <details>
        <summary>Liaison</summary>
        <div class="grid-2">
          <label>Comment le joindre <select class="protocol">${protocolOptions(protocol)}</select></label>
          <label>Port <input class="port mono" inputmode="numeric" value="${esc(port)}" placeholder="laisser vide"></label>
        </div>
      </details>
    </article>
  `;
}

function renderSettings() {
  const settings = state.settings || {};
  viewEl().innerHTML = `
    <article class="card login-card" id="phone-card">
      <h2>Relier un téléphone</h2>
      <p>Scanne ce carré avec l'appareil photo. La page s'ouvre. Tape le mot de passe, puis les 6 chiffres.</p>
      <div class="qr" id="entry-qr"></div>
      <p class="house-code" id="entry-code"></p>
      <details>
        <summary>Si l'application des 6 chiffres est perdue</summary>
        <div id="totp-reset" class="stack">
          <p class="help">Ça se fait ici. L'ancien carré ne marche plus dès que le nouveau est affiché.</p>
          <button type="button" class="btn" data-action="rotate-totp">Nouveau carré</button>
        </div>
      </details>
    </article>
    <div class="split">
      <form class="card stack" data-form="settings">
        <h2>Contrôle</h2>
        <p class="help">Si un appareil redémarre, le programme le retrouve tout seul.</p>
        <details>
          <summary>Si la recherche ne trouve pas le bon Wi-Fi</summary>
          <div class="stack">
            <label>Wi-Fi surveillé
              <input name="subnet" class="mono" value="${esc(settings.subnet || "")}" placeholder="${esc(state.network?.suggested_subnet || "192.168.1.0/24")}" spellcheck="false">
            </label>
            <label>Attente d'un appareil, en millisecondes
              <input name="ping_timeout_ms" type="number" min="200" max="1500" value="${esc(settings.ping_timeout_ms ?? 400)}">
            </label>
            <label>Vérification, en secondes
              <input name="poll_interval_s" type="number" min="10" max="3600" value="${esc(settings.poll_interval_s ?? 30)}">
            </label>
            <label>Attente d'une page, en secondes
              <input name="http_timeout_s" type="number" min="1" max="6" value="${esc(settings.http_timeout_s ?? 2)}">
            </label>
            <p class="help">Tu peux laisser ces chiffres.</p>
          </div>
        </details>
        <button class="btn primary" type="submit">Enregistrer</button>
      </form>
      <div class="stack">
        <section class="card stack">
          <h2>Types d'appareils</h2>
          ${state.types.map((item) => `
            <form class="inline" data-form="rename-type" data-id="${item.id}">
              <input name="name" value="${esc(item.name)}" aria-label="Nom du type">
              <button class="btn" type="submit">OK</button>
              <button class="btn" type="button" data-action="delete-type" data-id="${item.id}">Retirer</button>
            </form>
          `).join("")}
          <form class="inline" data-form="add-type">
            <input name="name" placeholder="Nouveau type" aria-label="Nouveau type">
            <button class="btn" type="submit">Ajouter</button>
          </form>
        </section>
        <section class="card stack">
          <h2>Pièces</h2>
          ${state.rooms.map((item) => `
            <form class="inline" data-form="rename-room" data-id="${item.id}">
              <input name="name" value="${esc(item.name)}" aria-label="Nom de la pièce">
              <button class="btn" type="submit">OK</button>
              <button class="btn" type="button" data-action="delete-room" data-id="${item.id}">Retirer</button>
            </form>
          `).join("")}
          <form class="inline" data-form="add-room">
            <input name="name" placeholder="Nouvelle pièce" aria-label="Nouvelle pièce">
            <button class="btn" type="submit">Ajouter</button>
          </form>
        </section>
      </div>
    </div>
  `;
  loadEntryCard();
}

function render() {
  paintChrome();
  if (needsProgram(state.dashboard) && (state.view === "dashboard" || state.view === "install")) {
    renderInstall();
    return;
  }
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "devices") renderDevices();
  else if (state.view === "scan") renderScan();
  else renderSettings();
  renderModal();
}

function blankDevice() {
  return {
    id: null,
    name: "",
    type_id: typeIdByName("Autre"),
    room_id: "",
    ip: "",
    mac: "",
    hostname: "",
    port: "",
    protocol: "ping",
    http_path: "/",
    notes: "",
  };
}

function renderModal() {
  const root = document.getElementById("modal-root");
  if (!state.modal) {
    root.innerHTML = "";
    document.body.classList.remove("modal-open");
    return;
  }
  document.body.classList.add("modal-open");
  const device = state.modal.device;
  const history = state.modal.history || [];
  const pageable = device.protocol === "http" || device.protocol === "https";
  const advanced = Boolean(
    (device.protocol && device.protocol !== "ping")
    || device.port
    || (device.http_path && device.http_path !== "/")
    || device.mac
    || device.notes
    || history.length
  );
  root.innerHTML = `
    <div class="backdrop" data-action="close-modal">
      <div class="panel stack" data-action="stop">
      <form class="stack" id="device-form" data-form="device">
        <h2>${device.id ? device.name || "Appareil" : "Nouvel appareil"}</h2>
        <label>Nom <input name="name" value="${esc(device.name)}" required></label>
        <div class="grid-2">
          <label>Pièce <select name="room_id">${options(state.rooms, device.room_id, "Sans pièce")}</select></label>
          <label>Type <select name="type_id">${options(state.types, device.type_id)}</select></label>
        </div>
        <label>Adresse sur le Wi-Fi
          <input name="ip" class="mono" value="${esc(device.ip)}" spellcheck="false" autocomplete="off" required>
        </label>
        <p class="help">Le programme la remet à jour si l'appareil redémarre.</p>
        <details ${advanced ? "open" : ""}>
          <summary>Plus de réglages</summary>
          <div class="stack">
            <div class="grid-3">
              <label>Comment le joindre <select name="protocol">${protocolOptions(device.protocol || "ping")}</select></label>
              <label>Port <input name="port" class="mono" inputmode="numeric" value="${esc(device.port ?? "")}" placeholder="automatique"></label>
              <label>Page <input name="http_path" value="${esc(device.http_path || "/")}" spellcheck="false"></label>
            </div>
            <label>Carte réseau, pour le suivre s'il change d'adresse
              <input name="mac" class="mono" value="${esc(device.mac || "")}" spellcheck="false" placeholder="facultatif">
            </label>
            <label>Note <textarea name="notes" rows="2">${esc(device.notes || "")}</textarea></label>
            ${history.length ? `<div><p>Adresses précédentes</p><ul class="history">${history.map(historyItem).join("")}</ul></div>` : ""}
          </div>
        </details>
        <input type="hidden" name="hostname" value="${esc(device.hostname || "")}">
        <p id="form-error" class="form-error" ${state.modal.error ? "" : "hidden"}>${esc(state.modal.error || "")}</p>
        <p id="test-result" class="quiet">${state.modal.test ? esc(describeCheck(state.modal.test)) : ""}</p>
        <div class="actions">
          <button class="btn primary" type="submit">${state.modal.conflict ? "Enregistrer quand même" : "Enregistrer"}</button>
          <button class="btn" type="button" data-action="test-link">Vérifier</button>
          <button class="btn" type="button" data-action="open-page" ${pageable ? "" : "hidden"}>Voir la page</button>
          ${device.id ? `<button class="btn danger" type="button" data-action="delete-device" data-id="${device.id}">Retirer</button>` : ""}
          <button class="btn" type="button" data-action="close-modal">Fermer</button>
        </div>
      </form>
      <section id="commands" class="stack">${commandsInner(device)}</section>
      </div>
    </div>
  `;
}

function presetOptions() {
  const groups = state.presets || [];
  if (!groups.length) return `<option value="volet">Volet</option>`;
  return groups.map((group) => `
    <optgroup label="${esc(group.name)}">
      ${group.items.map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("")}
    </optgroup>
  `).join("");
}

function methodOptions(kind, selected) {
  const items = kind === "stream"
    ? [["mjpeg", "MJPEG"], ["snapshot", "Image"], ["rtsp", "RTSP"]]
    : [["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"]];
  return items.map(([value, label]) => {
    const selectedAttr = value === selected ? " selected" : "";
    return `<option value="${value}"${selectedAttr}>${label}</option>`;
  }).join("");
}

function commandsInner(device) {
  if (!device.id) {
    return `<p class="help">Enregistre l'appareil. Tu ajouteras ses boutons juste après.</p>`;
  }
  const rows = (device.actions || []).map((item) => `
    <article class="command stack" data-command="${item.id}">
      <label>Nom du bouton <input class="cmd-label" value="${esc(item.label)}"></label>
      <p class="quiet cmd-try"></p>
      <div class="actions">
        <button type="button" class="btn" data-action="save-command">Enregistrer</button>
        ${item.kind === "http" && onHouseComputer() ? `<button type="button" class="btn" data-action="try-command">Essayer</button>` : ""}
        ${item.kind === "stream"
          ? `<button type="button" class="btn" data-action="show-stream" data-id="${device.id}" data-command="${item.id}" data-method="${esc(item.method)}" data-label="${esc(item.label)}">Voir</button>`
          : `<button type="button" class="btn" data-action="run-action" data-id="${device.id}" data-command="${item.id}">Lancer</button>`}
        <button type="button" class="btn" data-action="delete-command">Retirer</button>
      </div>
      <details>
        <summary>Si ce bouton ne marche pas</summary>
        <div class="stack">
          <div class="grid-3">
            <label>Type
              <select class="cmd-kind">
                <option value="http"${item.kind === "http" ? " selected" : ""}>Bouton</option>
                <option value="stream"${item.kind === "stream" ? " selected" : ""}>Image</option>
              </select>
            </label>
            <label>Envoi <select class="cmd-method">${methodOptions(item.kind, item.method)}</select></label>
            <label>Chemin <input class="cmd-path mono" value="${esc(item.path)}" spellcheck="false"></label>
          </div>
          <label class="cmd-body-label"${item.kind === "stream" ? " hidden" : ""}>Texte envoyé, facultatif <input class="cmd-body mono" value="${esc(item.body || "")}" spellcheck="false"></label>
          <div class="grid-2">
            <label>Identifiant, si l'appareil le demande <input class="cmd-user" value="${esc(item.auth_user || "")}" autocomplete="off"></label>
            <label>Mot de passe <input class="cmd-pass" type="password" value="${esc(item.auth_pass || "")}" autocomplete="off"></label>
          </div>
        </div>
      </details>
    </article>
  `).join("");
  return `
    <h2>Boutons</h2>
    <p class="help">Choisis un modèle, essaie, et garde les boutons qui marchent.</p>
    <div class="inline">
      <select id="preset">${presetOptions()}</select>
      <button type="button" class="btn" data-action="apply-preset">Ajouter ces boutons</button>
      <button type="button" class="btn" data-action="add-command">Un bouton</button>
    </div>
    ${rows || `<p class="quiet">Pas encore de bouton.</p>`}
  `;
}

function paintCommands() {
  const slot = document.getElementById("commands");
  if (!slot || !state.modal) return;
  slot.innerHTML = commandsInner(state.modal.device);
}

function commandPayload(row) {
  const kind = row.querySelector(".cmd-kind").value;
  return {
    label: row.querySelector(".cmd-label").value,
    kind,
    method: row.querySelector(".cmd-method").value,
    path: row.querySelector(".cmd-path").value,
    body: kind === "stream" ? "" : row.querySelector(".cmd-body").value,
    auth_user: row.querySelector(".cmd-user").value,
    auth_pass: row.querySelector(".cmd-pass").value,
  };
}

async function reloadCommands(deviceId) {
  state.modal.device.actions = await api(`/api/devices/${deviceId}/actions`);
  paintCommands();
  const board = await api("/api/dashboard");
  state.dashboard = board;
  state.devices = await api("/api/devices");
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "devices") {
    const rows = document.getElementById("device-rows");
    if (rows) {
      const list = filteredDevices();
      rows.innerHTML = list.map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil sous ce nom.</p>`;
    }
  }
}

function closeViewer() {
  clearInterval(state.viewerTimer);
  state.viewer = null;
  state.viewerTimer = null;
  const root = document.getElementById("viewer-root");
  if (root) root.innerHTML = "";
}

function renderViewer() {
  const root = document.getElementById("viewer-root");
  clearInterval(state.viewerTimer);
  if (!root || !state.viewer) {
    if (root) root.innerHTML = "";
    return;
  }
  const view = state.viewer;
  const src = `/api/devices/${view.deviceId}/actions/${view.actionId}/stream`;
  root.innerHTML = `
    <div class="backdrop viewer-back" data-action="close-viewer">
      <div class="panel viewer-panel" data-action="stop">
        <div class="actions">
          <h2>${esc(view.label || "Image")}</h2>
          <button type="button" class="btn" data-action="close-viewer">Fermer</button>
        </div>
        <img id="stream-img" alt="" src="${src}">
        <p class="help">Si l'image reste vide, ouvre l'appareil et change le chemin du bouton.</p>
      </div>
    </div>
  `;
  if (view.method === "snapshot") {
    state.viewerTimer = setInterval(() => {
      const img = document.getElementById("stream-img");
      if (img) img.src = `${src}?t=${Date.now()}`;
    }, 1000);
  }
}

function historyItem(item) {
  const from = item.old_ip ? `${item.old_ip} vers ${item.new_ip}` : item.new_ip;
  return `<li><span class="mono">${esc(from)}</span> <span class="quiet">${esc(SOURCE[item.source] || item.source)}, ${esc(ago(item.changed_at))}</span></li>`;
}

function describeCheck(result) {
  if (!result) return "";
  if (result.state === "online") return "L'appareil répond.";
  if (result.state === "degraded") return "L'appareil répond, mais pas sur cette page.";
  if (result.state === "offline") return "L'appareil ne répond pas.";
  return "Pas encore vérifié.";
}

function formDevice(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    name: data.name || "",
    type_id: Number(data.type_id),
    room_id: data.room_id ? Number(data.room_id) : null,
    ip: (data.ip || "").trim(),
    mac: data.mac || "",
    hostname: data.hostname || "",
    port: data.port ? Number(data.port) : null,
    protocol: data.protocol || "ping",
    http_path: data.http_path || "/",
    notes: data.notes || "",
    force: Boolean(state.modal && state.modal.conflict),
  };
}

function showFormError(message) {
  const el = document.getElementById("form-error");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function pageUrl(fields) {
  if (fields.protocol !== "http" && fields.protocol !== "https") return "";
  const port = fields.port || (fields.protocol === "https" ? 443 : 80);
  const path = fields.http_path || "/";
  const hidden = (fields.protocol === "http" && port === 80) || (fields.protocol === "https" && port === 443);
  return `${fields.protocol}://${fields.ip}${hidden ? "" : `:${port}`}${path}`;
}

async function hydrate() {
  const [devices, types, rooms, settings, network, dashboard, presets] = await Promise.all([
    api("/api/devices"),
    api("/api/types"),
    api("/api/rooms"),
    api("/api/settings"),
    api("/api/network"),
    api("/api/dashboard"),
    api("/api/presets"),
  ]);
  state.devices = devices;
  state.types = types;
  state.rooms = rooms;
  state.settings = settings;
  state.network = network;
  state.dashboard = dashboard;
  state.presets = presets;
}

async function openDevice(id) {
  const [device, history] = await Promise.all([
    api(`/api/devices/${id}`),
    api(`/api/devices/${id}/history`),
  ]);
  state.modal = { device, history, error: "", test: null, conflict: false };
  renderModal();
}

async function refreshView() {
  const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
  await hydrate();
  if (state.view === "scan") {
    try {
      state.scan = await api("/api/scan");
    } catch (_err) {
      /* le registre reste affiché */
    }
  }
  if (!state.modal) render();
  else paintChrome();
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

async function saveDevice(form) {
  const body = formDevice(form);
  const id = state.modal.device.id;
  try {
    const saved = await api(id ? `/api/devices/${id}` : "/api/devices", {
      method: id ? "PUT" : "POST",
      body,
    });
    state.modal = null;
    await refreshView();
    const check = saved.check || {};
    if (check.state === "online") toast("Enregistré.");
    else if (check.state === "degraded") toast("Enregistré. La page de l'appareil ne répond pas.");
    else toast("Enregistré. L'appareil ne répond pas pour le moment.");
  } catch (error) {
    if (error.status === 409) {
      state.modal.conflict = true;
      state.modal.error = `${error.message} Tu peux enregistrer quand même.`;
      const button = form.querySelector(".primary");
      if (button) button.textContent = "Enregistrer quand même";
      showFormError(state.modal.error);
      return;
    }
    showFormError(error.message);
  }
}

async function applyScan() {
  const creates = [];
  document.querySelectorAll("[data-new-row]").forEach((row) => {
    if (!row.querySelector(".pick")?.checked) return;
    const port = row.querySelector(".port").value.trim();
    creates.push({
      name: row.querySelector(".name").value,
      type_id: Number(row.querySelector(".type").value),
      room_id: row.querySelector(".room").value ? Number(row.querySelector(".room").value) : null,
      ip: row.dataset.ip,
      mac: row.dataset.mac || "",
      hostname: row.dataset.hostname || "",
      protocol: row.querySelector(".protocol").value,
      port: port ? Number(port) : null,
      http_path: "/",
    });
  });
  const updates = [];
  document.querySelectorAll("[data-change-row]").forEach((row) => {
    if (!row.querySelector(".pick")?.checked) return;
    updates.push({
      device_id: Number(row.dataset.id),
      ip: row.dataset.ip,
      mac: row.dataset.mac || "",
      hostname: row.dataset.hostname || "",
    });
  });
  if (!creates.length && !updates.length) {
    toast("Coche au moins un appareil.");
    return;
  }
  try {
    const result = await api("/api/scan/apply", { method: "POST", body: { creates, updates, force: false } });
    const added = result.created.length;
    const found = result.updated.length;
    const parts = [];
    if (added) parts.push(added > 1 ? `${added} ajoutés` : "1 ajouté");
    if (found) parts.push(found > 1 ? `${found} retrouvés` : "1 retrouvé");
    toast(parts.join(", ") + ".");
    state.scan = await api("/api/scan");
    await hydrate();
    render();
  } catch (error) {
    if (error.status === 409 && confirm(error.message + " Enregistrer quand même ?")) {
      try {
        const result = await api("/api/scan/apply", { method: "POST", body: { creates, updates, force: true } });
        const added = result.created.length;
        const found = result.updated.length;
        const parts = [];
        if (added) parts.push(added > 1 ? `${added} ajoutés` : "1 ajouté");
        if (found) parts.push(found > 1 ? `${found} retrouvés` : "1 retrouvé");
        toast(parts.join(", ") + ".");
        state.scan = await api("/api/scan");
        await hydrate();
        render();
      } catch (again) {
        toast(again.message);
      }
      return;
    }
    toast(error.message);
  }
}

async function poll() {
  if (state.view === "login" || state.view === "link" || state.modal) return;
  const active = document.activeElement;
  const typing = active && viewEl().contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
  if (typing) return;
  try {
    if (state.view === "dashboard" || state.view === "install") {
      const dashboard = await api("/api/dashboard");
      const key = JSON.stringify(dashboard);
      state.dashboard = dashboard;
      state.devices = dashboard.devices || state.devices;
      if (needsProgram(dashboard)) {
        if (state.view !== "install") renderInstall();
        return;
      }
      if (state.view === "install") {
        state.view = "dashboard";
        state.dashKey = key;
        render();
        return;
      }
      if (key !== state.dashKey) {
        state.dashKey = key;
        const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
        renderDashboard();
        paintChrome();
        if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
      }
    } else if (state.view === "devices") {
      const devices = await api("/api/devices");
      const key = JSON.stringify(devices);
      if (key !== state.deviceKey) {
        state.deviceKey = key;
        state.devices = devices;
        const rows = document.getElementById("device-rows");
        if (rows) rows.innerHTML = filteredDevices().map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil sous ce nom.</p>`;
      }
    } else if (state.view === "scan" && state.scanning) {
      const scan = await api("/api/scan");
      const was = state.scan?.state;
      state.scan = scan;
      const box = document.getElementById("scan-form");
      if (scan.state === "running" && box) {
        const width = scan.total ? Math.min(100, Math.round((scan.done / scan.total) * 100)) : 0;
        const progress = box.querySelector(".progress");
        if (!progress) {
          render();
          return;
        }
        const label = progress.previousElementSibling;
        if (label) label.textContent = `Recherche, ${scan.done} sur ${scan.total}. ${scan.responding || 0} trouvé${scan.responding > 1 ? "s" : ""}.`;
        progress.querySelector("span").style.width = `${width}%`;
      }
      if (was === "running" && scan.state !== "running") {
        state.scanning = false;
        render();
      }
    }
  } catch (error) {
    if (error.status === 401) renderLogin();
  }
}

document.body.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "stop") return;
  if (action === "other-house") {
    state.pickHouse = true;
    renderLogin();
    return;
  }
  if (action === "rotate-totp") {
    try {
      const fresh = await api("/api/link/totp", { method: "POST", body: {} });
      const slot = document.getElementById("totp-reset");
      if (slot) {
        slot.innerHTML = `<p>Scanne ce nouveau carré dans l'application des 6 chiffres. L'ancien ne marche plus.</p><div class="qr">${qrMarkup(fresh.qr)}</div><details><summary>Si le scan ne marche pas</summary><p class="secret-key">${esc(fresh.secret || "")}</p></details>`;
      }
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "nav") {
    state.view = el.dataset.view;
    state.modal = null;
    if (state.view === "scan" && !state.scan) {
      state.scan = await api("/api/scan");
      state.scanning = state.scan.state === "running";
    }
    render();
    return;
  }
  if (action === "dash-filter") {
    state.dashStatus = el.dataset.status;
    renderDashboard();
    return;
  }
  if (action === "add-device") {
    state.modal = { device: blankDevice(), history: [], error: "", test: null, conflict: false };
    renderModal();
    return;
  }
  if (action === "open-device") {
    await openDevice(el.dataset.id);
    return;
  }
  if (action === "close-modal") {
    state.modal = null;
    renderModal();
    return;
  }
  if (action === "close-viewer") {
    closeViewer();
    return;
  }
  if (action === "run-action") {
    const key = commandKey(el.dataset.id, el.dataset.command);
    if (state.pending.has(key)) return;
    const label = el.textContent;
    state.pending.add(key);
    const onBoard = state.view === "dashboard" && !state.modal;
    if (onBoard) renderDashboard();
    else {
      el.disabled = true;
      el.textContent = "En cours";
    }
    try {
      const result = await finishCommand(await api(`/api/devices/${el.dataset.id}/actions/${el.dataset.command}/run`, { method: "POST", body: {} }));
      toast(commandOutcome(result));
    } catch (error) {
      toast(error.message);
    } finally {
      state.pending.delete(key);
      if (state.view === "dashboard" && !state.modal) renderDashboard();
      else if (el.isConnected) {
        el.disabled = false;
        el.textContent = label;
      }
    }
    return;
  }
  if (action === "try-command") {
    const row = el.closest(".command");
    const slot = row.querySelector(".cmd-try");
    el.disabled = true;
    try {
      const result = await api(`/api/devices/${state.modal.device.id}/actions/try`, {
        method: "POST",
        body: commandPayload(row),
      });
      if (slot) slot.textContent = commandOutcome(result);
    } catch (error) {
      if (slot) slot.textContent = error.message;
    } finally {
      el.disabled = false;
    }
    return;
  }
  if (action === "show-stream") {
    if (location.hostname.endsWith(".vercel.app")) {
      toast("L'image se regarde à la maison, sur l'ordinateur où le programme est ouvert.");
      return;
    }
    state.viewer = {
      deviceId: el.dataset.id,
      actionId: el.dataset.command,
      method: el.dataset.method || "mjpeg",
      label: el.dataset.label || "Image",
    };
    renderViewer();
    return;
  }
  if (action === "add-command") {
    try {
      await api(`/api/devices/${state.modal.device.id}/actions`, {
        method: "POST",
        body: { label: "Commande", kind: "http", method: "GET", path: "/" },
      });
      await reloadCommands(state.modal.device.id);
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "apply-preset") {
    const preset = document.getElementById("preset");
    try {
      await api(`/api/devices/${state.modal.device.id}/actions/preset`, {
        method: "POST",
        body: { preset: preset ? preset.value : "volet" },
      });
      await reloadCommands(state.modal.device.id);
      toast("Boutons ajoutés. Essaie-les.");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "save-command") {
    const row = el.closest(".command");
    try {
      await api(`/api/devices/${state.modal.device.id}/actions/${row.dataset.command}`, {
        method: "PUT",
        body: commandPayload(row),
      });
      await reloadCommands(state.modal.device.id);
      toast("Bouton enregistré.");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "delete-command") {
    const row = el.closest(".command");
    if (!confirm("Retirer ce bouton ?")) return;
    try {
      await api(`/api/devices/${state.modal.device.id}/actions/${row.dataset.command}`, { method: "DELETE" });
      await reloadCommands(state.modal.device.id);
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "check-now") {
    await api("/api/check", { method: "POST", body: {} });
    toast("Contrôle lancé.");
    setTimeout(poll, 1200);
    return;
  }
  if (action === "use-suggested" && state.network?.suggested_subnet) {
    state.scanDraft = state.network.suggested_subnet;
    render();
    return;
  }
  if (action === "cancel-scan") {
    await api("/api/scan/cancel", { method: "POST", body: {} });
    return;
  }
  if (action === "check-new") {
    document.querySelectorAll("[data-new-row] .pick").forEach((box) => {
      box.checked = true;
    });
    return;
  }
  if (action === "apply-scan") {
    await applyScan();
    return;
  }
  if (action === "test-link") {
    const form = document.getElementById("device-form");
    const fields = formDevice(form);
    try {
      const result = await api("/api/probe", { method: "POST", body: fields });
      const slot = document.getElementById("test-result");
      if (slot) slot.textContent = describeCheck(result);
    } catch (error) {
      showFormError(error.message);
    }
    return;
  }
  if (action === "open-page") {
    const url = pageUrl(formDevice(document.getElementById("device-form")));
    if (url) window.open(url, "_blank", "noopener");
    return;
  }
  if (action === "delete-device") {
    const device = state.modal?.device;
    if (!device?.id) return;
    const label = device.name || "cet appareil";
    if (!confirm("Retirer « " + label + " » ? Il reste allumé, il disparaît seulement d'ici.")) return;
    await api(`/api/devices/${device.id}`, { method: "DELETE" });
    state.modal = null;
    await refreshView();
    toast("Retiré.");
    return;
  }
  if (action === "delete-type") {
    try {
      await api(`/api/types/${el.dataset.id}`, { method: "DELETE" });
      await refreshView();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "delete-room") {
    try {
      await api(`/api/rooms/${el.dataset.id}`, { method: "DELETE" });
      await refreshView();
    } catch (error) {
      toast(error.message);
    }
  }
});

document.body.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const kind = form.dataset.form;
  try {
    if (kind === "device") {
      await saveDevice(form);
      return;
    }
    if (kind === "scan") {
      const subnet = document.getElementById("subnet").value.trim();
      state.scanDraft = subnet;
      state.scanDeep = document.getElementById("deep").checked;
      if (hostEstimate(subnet) == null) {
        toast("Ce Wi-Fi n'est pas reconnu. Exemple : 192.168.1.0/24.");
        return;
      }
      state.scan = await api("/api/scan", { method: "POST", body: { subnet, deep: state.scanDeep } });
      state.scanning = state.scan.state === "running";
      render();
      return;
    }
    if (kind === "settings") {
      const data = Object.fromEntries(new FormData(form).entries());
      state.settings = await api("/api/settings", {
        method: "PUT",
        body: {
          subnet: data.subnet || "",
          ping_timeout_ms: Number(data.ping_timeout_ms),
          poll_interval_s: Number(data.poll_interval_s),
          http_timeout_s: Number(data.http_timeout_s),
        },
      });
      toast("C'est enregistré.");
      paintChrome();
      return;
    }
    if (kind === "add-type" || kind === "rename-type") {
      const name = new FormData(form).get("name");
      if (kind === "add-type") await api("/api/types", { method: "POST", body: { name } });
      else await api(`/api/types/${form.dataset.id}`, { method: "PUT", body: { name } });
      await refreshView();
      return;
    }
    if (kind === "add-room" || kind === "rename-room") {
      const name = new FormData(form).get("name");
      if (kind === "add-room") await api("/api/rooms", { method: "POST", body: { name } });
      else await api(`/api/rooms/${form.dataset.id}`, { method: "PUT", body: { name } });
      await refreshView();
    }
  } catch (error) {
    if (kind === "device") showFormError(error.message);
    else toast(error.message);
  }
});

document.body.addEventListener("input", (event) => {
  if (event.target.id === "q") {
    state.deviceQuery = event.target.value;
    const rows = document.getElementById("device-rows");
    if (rows) {
      const list = filteredDevices();
      rows.innerHTML = list.map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil sous ce nom.</p>`;
    }
  }
  if (event.target.id === "subnet") {
    state.scanDraft = event.target.value;
    const estimate = document.getElementById("estimate");
    const count = hostEstimate(event.target.value);
    if (estimate) {
      estimate.textContent = count == null
        ? "Exemple : 192.168.1.0/24."
        : `Environ ${count} adresses. Comptez une à deux minutes.`;
    }
  }
  if (event.target.id === "deep") state.scanDeep = event.target.checked;
});

document.body.addEventListener("change", (event) => {
  if (event.target.id === "f-type") state.deviceType = event.target.value;
  if (event.target.id === "f-room") state.deviceRoom = event.target.value;
  if (event.target.id === "f-status") state.deviceStatus = event.target.value;
  if (["f-type", "f-room", "f-status"].includes(event.target.id)) {
    const rows = document.getElementById("device-rows");
    if (rows) {
      const list = filteredDevices();
      rows.innerHTML = list.map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil sous ce nom.</p>`;
    }
  }
  if (event.target.name === "protocol") {
    const form = event.target.form;
    const port = form.elements.port;
    const defaults = { http: 80, https: 443, rtsp: 554, tcp: "", ping: "" };
    if (port && !port.dataset.touched) port.value = defaults[event.target.value] ?? "";
    const opener = form.querySelector("[data-action=open-page]");
    const show = event.target.value === "http" || event.target.value === "https";
    if (opener) opener.hidden = !show;
  }
  if (event.target.name === "port") event.target.dataset.touched = "1";
  if (event.target.classList && event.target.classList.contains("cmd-kind")) {
    const row = event.target.closest(".command");
    const select = row.querySelector(".cmd-method");
    const kind = event.target.value;
    select.innerHTML = methodOptions(kind, kind === "stream" ? "mjpeg" : "GET");
    const bodyLabel = row.querySelector(".cmd-body-label");
    if (bodyLabel) bodyLabel.hidden = kind === "stream";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modal) {
    state.modal = null;
    renderModal();
  }
});

let polling = false;

function paintPlace() {
  const foot = document.querySelector(".aside-foot");
  if (!foot) return;
  if (location.hostname.endsWith(".vercel.app")) {
    const code = state.dashboard?.house?.code || state.houseCode || "";
    foot.textContent = code ? `Maison ${code}` : "Entre le code de la maison.";
    return;
  }
  foot.textContent = state.houseCode
    ? `Code de la maison : ${state.houseCode}. Laisse cette fenêtre ouverte.`
    : "Laisse cette fenêtre ouverte.";
}

function onHouseComputer() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

function needsProgram(dashboard) {
  return Boolean(dashboard && dashboard.house && !dashboard.house.at);
}

function renderInstall() {
  state.view = "install";
  paintChrome();
  paintPlace();
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Installation";
  viewEl().innerHTML = `
    <article class="card login-card">
      <h2>Première fois</h2>
      <ol class="steps-list">
        <li>Sur l'ordinateur du Wi-Fi, installe le programme et laisse la fenêtre ouverte.</li>
        <li>Choisis le mot de passe, puis scanne le carré dans l'application des codes à 6 chiffres.</li>
        <li>Scanne le second carré avec l'appareil photo. Cette page s'ouvre. Tape le mot de passe et les 6 chiffres.</li>
      </ol>
      <a class="btn primary" href="${RELEASE}">Télécharger maMaisonConnectee pour Windows</a>
      <p class="help">Dès que l'ordinateur est allumé, la maison s'affiche ici.</p>
    </article>`;
}

function renderCreate() {
  state.view = "link";
  paintChrome();
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Mot de passe";
  viewEl().innerHTML = `
    <article class="card login-card">
      <p class="steps">Étape 1 sur 3</p>
      <h2>Le mot de passe</h2>
      <p>Choisis celui que la famille tapera sur le téléphone. Un mot qu'elle retient, et que personne d'autre ne connaît. Au moins 8 caractères.</p>
      <form id="link-form">
        <label>Mot de passe
          <input type="password" name="password" autocomplete="new-password" required minlength="8">
        </label>
        <label>Encore le mot de passe
          <input type="password" name="confirm" autocomplete="new-password" required minlength="8">
        </label>
        <p class="form-error" id="link-error"></p>
        <button class="btn primary" type="submit">Continuer</button>
      </form>
    </article>`;
  document.getElementById("link-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirm") || "");
    const box = document.getElementById("link-error");
    if (password.length < 8) {
      if (box) box.textContent = "Le mot de passe doit contenir au moins 8 caractères.";
      return;
    }
    if (password !== confirm) {
      if (box) box.textContent = "Les deux mots de passe sont différents.";
      return;
    }
    try {
      const linked = await api("/api/link", { method: "POST", body: { password } });
      rememberSetup(linked);
      renderReady(linked);
    } catch (error) {
      if (box) box.textContent = error.message;
    }
  });
}

function rememberSetup(linked) {
  const pending = {
    house: linked.house || "",
    secret: linked.secret || "",
    qr: linked.qr || "",
    confirmed: Boolean(linked.confirmed),
  };
  sessionStorage.setItem("maison-setup", JSON.stringify(pending));
  return pending;
}

function pendingSetup() {
  try {
    const raw = sessionStorage.getItem("maison-setup");
    return raw ? JSON.parse(raw) : null;
  } catch (_err) {
    return null;
  }
}

function qrMarkup(svg) {
  if (typeof svg !== "string" || !svg.includes("<svg") || svg.toLowerCase().includes("<script")) return "";
  return svg;
}

function renderReady(linked) {
  const code = linked.house || "";
  const secret = linked.secret || "";
  state.view = "link";
  state.houseCode = code;
  paintChrome();
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Les 6 chiffres";
  viewEl().innerHTML = `
    <article class="card login-card">
      <p class="steps">Étape 2 sur 3</p>
      <h2>Scanne le carré</h2>
      <p>Sur le téléphone, ouvre l'application qui affiche des codes à 6 chiffres. Scanne ce carré.</p>
      <div class="qr">${qrMarkup(linked.qr)}</div>
      <form id="otp-form">
        <label>Les 6 chiffres affichés
          <input name="otp" inputmode="numeric" autocomplete="one-time-code" required>
        </label>
        <p class="form-error" id="otp-error"></p>
        <button class="btn primary" type="submit">Continuer</button>
      </form>
      <details>
        <summary>Si le scan ne marche pas</summary>
        <p class="secret-key">${esc(secret)}</p>
        <button type="button" class="btn" id="new-qr">Refaire le carré</button>
      </details>
    </article>`;
  document.getElementById("otp-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const otp = new FormData(event.target).get("otp");
    try {
      await api("/api/link/confirm", { method: "POST", body: { code: otp } });
      const pending = pendingSetup() || { house: code };
      pending.confirmed = true;
      pending.secret = "";
      sessionStorage.setItem("maison-setup", JSON.stringify(pending));
      state.houseCode = code;
      await renderPhone();
    } catch (error) {
      const box = document.getElementById("otp-error");
      if (box) box.textContent = error.message;
    }
  });
  document.getElementById("new-qr").addEventListener("click", async () => {
    try {
      const fresh = await api("/api/link/totp", { method: "POST", body: {} });
      fresh.house = fresh.house || code;
      rememberSetup(fresh);
      renderReady(fresh);
    } catch (error) {
      const box = document.getElementById("otp-error");
      if (box) box.textContent = error.message;
    }
  });
}

function houseFromQuery() {
  const raw = new URLSearchParams(location.search).get("maison") || "";
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 8) return "";
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

async function loadEntryCard() {
  const slot = document.getElementById("entry-qr");
  const code = document.getElementById("entry-code");
  if (!slot) return;
  try {
    const entry = await api("/api/link/entry");
    slot.innerHTML = qrMarkup(entry.qr);
    if (code) code.textContent = entry.house || "";
  } catch (_err) {
    slot.textContent = "Le carré apparaît quand la maison est créée sur cet ordinateur.";
  }
}

async function renderPhone() {
  state.view = "link";
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Le téléphone";
  paintChrome();
  viewEl().innerHTML = `
    <article class="card login-card">
      <p class="steps">Étape 3 sur 3</p>
      <h2>Ouvre le téléphone</h2>
      <p>Avec l'appareil photo, scanne ce carré. La page s'ouvre. Tape le mot de passe, puis les 6 chiffres.</p>
      <div class="qr" id="entry-qr"></div>
      <p class="house-code" id="entry-code">${esc(state.houseCode || "")}</p>
      <p class="help">Ce carré n'ouvre pas la maison tout seul. Le mot de passe et les 6 chiffres du moment restent demandés.</p>
      <button type="button" class="btn primary" id="setup-done">C'est fait</button>
    </article>`;
  document.getElementById("setup-done").addEventListener("click", async () => {
    sessionStorage.removeItem("maison-setup");
    state.view = "dashboard";
    await boot();
  });
  await loadEntryCard();
}

function renderLink() {
  renderCreate();
}

function renderLogin() {
  state.view = "login";
  paintChrome();
  paintPlace();
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Entrée";
  const known = houseFromQuery();
  const askCode = !known || state.pickHouse;
  viewEl().innerHTML = `
    <article class="card login-card">
      <h2>Entrer</h2>
      <p>${askCode ? "Le code est affiché sur l'ordinateur de la maison." : "Maison reconnue."} Tape le mot de passe choisi là-bas, puis les 6 chiffres du téléphone.</p>
      <form id="login-form">
        ${askCode ? `
          <label>Code de la maison
            <input name="house" value="${esc(known)}" autocapitalize="characters" autocomplete="off" required>
          </label>
        ` : `
          <p class="house-code">${esc(known)}</p>
          <input type="hidden" name="house" value="${esc(known)}">
        `}
        <label>Mot de passe
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <label>6 chiffres
          <input name="otp" inputmode="numeric" autocomplete="one-time-code" required>
        </label>
        <p class="form-error" id="login-error"></p>
        <button class="btn primary" type="submit">Entrer</button>
      </form>
      ${askCode ? "" : `<button type="button" class="btn" data-action="other-house">Autre maison</button>`}
      <p class="help">Cinq erreurs ferment l'entrée pendant 15 minutes.</p>
    </article>`;
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/login", { method: "POST", body: { house: form.get("house"), password: form.get("password"), otp: form.get("otp") } });
      state.view = "dashboard";
      await boot();
    } catch (error) {
      const box = document.getElementById("login-error");
      if (box) box.textContent = error.message;
    }
  });
}

async function finishCommand(result) {
  if (!result || !result.queued || !result.id) return result || {};
  for (let step = 0; step < 20; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await api(`/api/jobs/${result.id}`);
    if (job.done) return job.result || { ok: true, detail: "C'est fait." };
  }
  return { ok: false, detail: "La maison ne répond pas. Allume l'ordinateur où le programme est ouvert." };
}

async function boot() {
  try {
    if (onHouseComputer()) {
      const link = await api("/api/link");
      state.houseCode = link.house || state.houseCode || "";
      if (!link.linked) {
        sessionStorage.removeItem("maison-setup");
        renderCreate();
        return;
      }
      const pending = pendingSetup();
      if (pending && pending.house === link.house && pending.confirmed) {
        await renderPhone();
        return;
      }
      if (pending && pending.house === link.house && pending.secret) {
        renderReady(pending);
        return;
      }
    }
    await hydrate();
    state.scan = await api("/api/scan");
    state.scanning = state.scan.state === "running";
    if (state.view === "login" || state.view === "link") state.view = "dashboard";
    paintPlace();
    render();
    if (!polling) {
      polling = true;
      setInterval(poll, 4000);
    }
  } catch (error) {
    if (error.status === 401) {
      renderLogin();
      return;
    }
    viewEl().innerHTML = `<p class="empty">${esc(error.message)} Recharge la page. Si le programme est fermé, rouvre-le.</p>`;
  }
}

boot();
