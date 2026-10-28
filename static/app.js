const TITLES = {
  dashboard: "Tableau de bord",
  devices: "Appareils",
  scan: "Détection",
  settings: "Réglages",
};

const STATE_LABEL = {
  online: "En ligne",
  offline: "Hors ligne",
  degraded: "Partiel",
  unknown: "Pas encore contrôlé",
};

const SOURCE = {
  manuel: "modifiée dans la console",
  detection: "repérée sur le réseau",
  suivi: "suivie après redémarrage",
  creation: "première adresse",
};

const PROTOCOLS = [
  ["ping", "Ping"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["rtsp", "RTSP, caméra"],
  ["tcp", "TCP, port précis"],
];

const RELEASE = "https://github.com/dariohd/maMaison/releases/latest/download/maMaison.exe";

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
  const label = STATE_LABEL[device.state] || STATE_LABEL.unknown;
  if (device.state === "online" && device.latency_ms != null) return `${label}, ${device.latency_ms} ms`;
  return label;
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
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  document.getElementById("view-title").textContent = TITLES[state.view] || "maMaison";
  const subnet = subnetDefault();
  document.getElementById("eyebrow").textContent = subnet ? `Réseau ${subnet}` : "Réseau de la maison";
  const meta = [];
  if (state.network?.local_ip) meta.push(`Cet ordinateur ${state.network.local_ip}`);
  if (state.network?.gateway) meta.push(`passerelle ${state.network.gateway}`);
  document.getElementById("top-meta").textContent = meta.join(" · ");
}

function deviceRow(device) {
  const room = device.room_name || "Non classé";
  const host = device.hostname && device.hostname !== device.name ? device.hostname : "";
  const conflict = device.ip_conflict ? `<span class="badge warn">Adresse en double</span>` : "";
  const commands = (device.actions || []).map((item) => {
    if (item.kind === "stream") {
      return `<button type="button" class="btn tiny" data-action="show-stream" data-id="${device.id}" data-command="${item.id}" data-method="${esc(item.method)}" data-label="${esc(item.label)}">${esc(item.label)}</button>`;
    }
    return `<button type="button" class="btn tiny" data-action="run-action" data-id="${device.id}" data-command="${item.id}">${esc(item.label)}</button>`;
  }).join("");
  return `
    <article class="row static">
      <i class="dot ${esc(device.state || "unknown")}"></i>
      <button type="button" class="name-btn" data-action="open-device" data-id="${device.id}">
        <strong>${esc(device.name)}${conflict}</strong>
        <span class="sub">${esc(host || device.detail || "")}</span>
      </button>
      <span>${esc(device.type_name || "")}<span class="sub">${esc(room)}</span></span>
      <span class="mono">${esc(device.ip)}</span>
      <span class="state-${esc(device.state || "unknown")}">${esc(statusText(device))}<span class="sub">${esc(linkLabel(device))} · ${esc(ago(device.last_checked))}</span></span>
      ${commands ? `<div class="row-actions">${commands}</div>` : ""}
    </article>
  `;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) {
    viewEl().innerHTML = `<p class="empty">Chargement du registre.</p>`;
    return;
  }
  const counts = data.counts || {};
  const house = data.house;
  const houseNote = !house
    ? ""
    : house.online
      ? `<p class="house-note">L'ordinateur de la maison répond. Les boutons partent depuis ce téléphone.</p>`
      : `<p class="house-note">L'ordinateur de cette maison ne répond pas. Ouvre maMaison sur son Wi-Fi et laisse la fenêtre ouverte. <a href="${RELEASE}">Télécharger le programme</a> s'il n'est pas encore là.</p>`;
  const attention = data.attention || [];
  const devices = data.devices || [];
  const bars = (data.by_type || []).map((item) => {
    const pct = item.total ? Math.round((item.online / item.total) * 100) : 0;
    return `
      <div class="bar-line">
        <span>${esc(item.name)}</span>
        <div class="track"><span style="width:${pct}%"></span></div>
        <span class="quiet">${item.online} / ${item.total}</span>
      </div>
    `;
  }).join("");
  const chips = [
    ["all", "Tous"],
    ["offline", "Hors ligne"],
    ["degraded", "Partiels"],
    ["online", "En ligne"],
    ["unknown", "Pas contrôlés"],
  ].map(([value, label]) => `
    <button type="button" class="chip${state.dashStatus === value ? " is-on" : ""}" data-action="dash-filter" data-status="${value}">${label}</button>
  `).join("");
  const visible = devices.filter((device) => state.dashStatus === "all" || device.state === state.dashStatus);
  viewEl().innerHTML = `
    ${houseNote}
    <section class="stats">
      <article class="stat"><span>Appareils</span><b>${counts.total || 0}</b></article>
      <article class="stat online"><span>En ligne</span><b>${counts.online || 0}</b></article>
      <article class="stat offline"><span>Hors ligne</span><b>${counts.offline || 0}</b></article>
      <article class="stat partial"><span>Partiels</span><b>${counts.degraded || 0}</b></article>
    </section>
    <div class="toolbar">
      <button type="button" class="btn primary" data-action="nav" data-view="scan">Analyser le Wi-Fi</button>
      <button type="button" class="btn" data-action="add-device">Ajouter un appareil</button>
      <button type="button" class="btn" data-action="check-now">Contrôler maintenant</button>
      ${data.last_scan ? `<span class="quiet">Dernière détection ${esc(ago(data.last_scan))}</span>` : ""}
    </div>
    ${counts.total ? "" : `<p class="empty">Aucun appareil n'est encore enregistré. Lancez une détection pour lire le Wi-Fi, puis classez les volets, les caméras, les radiateurs et le reste.</p>`}
    <div class="layout">
      <section class="stack">
        ${attention.length ? `
          <article class="card">
            <h2>À regarder</h2>
            <div class="list">${attention.map((device) => deviceRow(device)).join("")}</div>
          </article>
        ` : ""}
        <article class="card">
          <div class="toolbar">
            <h2>Ensemble de la maison</h2>
            <div class="chips">${chips}</div>
          </div>
          <div class="list">${visible.length ? visible.map((device) => deviceRow(device)).join("") : `<p class="quiet">Rien dans ce filtre.</p>`}</div>
        </article>
      </section>
      <aside class="card">
        <h2>Par type</h2>
        <div class="bars">${bars || `<p class="quiet">Les types apparaîtront avec les appareils.</p>`}</div>
      </aside>
    </div>
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
      <input id="q" class="grow" placeholder="Nom, adresse, pièce, MAC" value="${esc(state.deviceQuery)}">
      <select id="f-type">${options(state.types, state.deviceType, "Tous les types")}</select>
      <select id="f-room">${options(state.rooms, state.deviceRoom, "Toutes les pièces")}</select>
      <select id="f-status">
        <option value="">Tous les états</option>
        ${["online", "offline", "degraded", "unknown"].map((value) => `<option value="${value}"${state.deviceStatus === value ? " selected" : ""}>${STATE_LABEL[value]}</option>`).join("")}
      </select>
      <button type="button" class="btn primary" data-action="add-device">Ajouter</button>
    </div>
    <div class="list" id="device-rows">
      ${rows.length ? rows.map((device) => deviceRow(device)).join("") : `<p class="empty">Aucun appareil ne correspond. Ajoutez-en un, ou lancez une détection.</p>`}
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
  const phase = scan?.phase === "ports" ? "Vérification des services" : "Ping";
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
      <p>La détection lit le Wi-Fi de la maison, propose un type et une liaison, puis vous laisse choisir ce qui entre dans le registre. L'adresse d'un appareil déjà connu peut être mise à jour ici.</p>
      ${state.network?.suggested_subnet ? `<p>Réseau proposé : <strong>${esc(state.network.adapter_name || "Carte active")}</strong>, <span class="mono">${esc(state.network.suggested_subnet)}</span>${state.network.gateway ? `, passerelle <span class="mono">${esc(state.network.gateway)}</span>` : ""}.</p>` : `<p>Branchez cet ordinateur au Wi-Fi de la maison, ou indiquez le réseau à la main.</p>`}
      <div class="grid-2">
        <label>Réseau à analyser
          <input id="subnet" name="subnet" class="mono" value="${esc(subnet)}" spellcheck="false" autocomplete="off" ${running ? "disabled" : ""}>
        </label>
        <label class="line"><input id="deep" type="checkbox" ${state.scanDeep ? "checked" : ""} ${running ? "disabled" : ""}> Chercher aussi les adresses muettes au ping. C'est plus long.</label>
      </div>
      <p class="quiet" id="estimate">${estimate == null ? "Maximum : un réseau /22, par exemple 192.168.1.0/24." : `Environ ${estimate} adresses. Comptez une à deux minutes.`}</p>
      <div class="actions">
        <button class="btn primary" type="submit" ${running ? "disabled" : ""}>Analyser le réseau</button>
        <button class="btn" type="button" data-action="use-suggested" ${running ? "disabled" : ""}>Reprendre le réseau proposé</button>
        ${running ? `<button class="btn" type="button" data-action="cancel-scan">Arrêter</button>` : ""}
      </div>
      ${running ? `<div><p>${esc(phase)} ${scan.done} / ${scan.total}. ${scan.responding || 0} répondant${scan.responding > 1 ? "s" : ""}.</p><div class="progress"><span style="width:${width}%"></span></div></div>` : ""}
      ${scan && scan.state === "cancelled" ? `<p class="quiet">Analyse arrêtée. Les appareils déjà vus sont ci-dessous.</p>` : ""}
    </form>
    ${body}
    ${others.length ? `<details><summary>Autres cartes réseau</summary><div class="list">${others.map((item) => `<p class="mono">${esc(item.name)} · ${esc(item.ip)} · ${esc(item.subnet)}${item.gateway ? "" : " · sans passerelle"}</p>`).join("")}</div></details>` : ""}
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
        <button type="button" class="btn primary" data-action="apply-scan">Enregistrer la sélection</button>
        <button type="button" class="btn" data-action="check-new">Cocher les nouveaux</button>
        <span class="quiet">${scan.responding || 0} réponses sur ${esc(scan.subnet || "")}</span>
      </div>
      <h2>Adresses à mettre à jour</h2>
      ${changed.length ? `<div class="list">${changed.map(renderChanged).join("")}</div>` : `<p class="quiet">Aucune adresse connue n'a bougé.</p>`}
      ${conflicts.length ? `<h2>Conflits</h2><div class="list">${conflicts.map(renderConflict).join("")}</div>` : ""}
      <h2>Nouveaux appareils</h2>
      ${fresh.length ? `<div class="list">${fresh.map(renderFresh).join("")}</div>` : `<p class="quiet">Pas de nouvel appareil sur cette analyse.</p>`}
      <details>
        <summary>Déjà suivis, adresse inchangée (${known.length})</summary>
        <div class="list">${known.map((item) => `<p><strong>${esc(item.device_name)}</strong> <span class="mono">${esc(item.ip)}</span> <span class="quiet">${esc(scanHints(item))}</span></p>`).join("") || `<p class="quiet">Aucun.</p>`}</div>
      </details>
    </section>
  `;
}

function renderChanged(item) {
  return `
    <article class="scan-card" data-change-row data-id="${item.device_id}" data-ip="${esc(item.ip)}" data-mac="${esc(item.mac || "")}" data-hostname="${esc(item.hostname || "")}">
      <header>
        <label class="line"><input class="pick" type="checkbox" checked> <strong>${esc(item.device_name)}</strong></label>
        <span class="mono">${esc(item.previous_ip)} vers ${esc(item.ip)}</span>
      </header>
      <p class="quiet">${esc(scanHints(item))}</p>
    </article>
  `;
}

function renderConflict(item) {
  return `
    <article class="scan-card">
      <header>
        <strong class="mono">${esc(item.ip)}</strong>
        <span>déjà notée pour ${esc(item.device_name)}</span>
      </header>
      <p class="quiet">Une autre adresse MAC répond à cette adresse. Ouvrez la fiche concernée et corrigez-la à la main. ${esc(scanHints(item))}</p>
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
        <label class="line"><input class="pick" type="checkbox"> <span class="mono">${esc(item.ip)}</span></label>
        ${item.is_self ? `<span class="badge">Cet ordinateur</span>` : ""}
        ${item.is_gateway ? `<span class="badge">Passerelle</span>` : ""}
      </header>
      <div class="grid-3">
        <label>Nom <input class="name" value="${esc(name)}"></label>
        <label>Type <select class="type">${options(state.types, typeIdByName(item.suggested_type))}</select></label>
        <label>Pièce <select class="room">${options(state.rooms, "", "Non classé")}</select></label>
      </div>
      <div class="grid-2">
        <label>Liaison <select class="protocol">${protocolOptions(protocol)}</select></label>
        <label>Port <input class="port mono" inputmode="numeric" value="${esc(port)}" placeholder="vide si ping"></label>
      </div>
      <p class="quiet">${esc(scanHints(item))}${item.suggested_type ? ` · piste : ${esc(item.suggested_type)}` : ""}</p>
    </article>
  `;
}

function renderSettings() {
  const settings = state.settings || {};
  viewEl().innerHTML = `
    <div class="split">
      <form class="card stack" data-form="settings">
        <h2>Détection et contrôle</h2>
        <label>Réseau surveillé
          <input name="subnet" class="mono" value="${esc(settings.subnet || "")}" placeholder="${esc(state.network?.suggested_subnet || "192.168.1.0/24")}" spellcheck="false">
        </label>
        <label>Délai de ping, en millisecondes
          <input name="ping_timeout_ms" type="number" min="200" max="1500" value="${esc(settings.ping_timeout_ms ?? 400)}">
        </label>
        <label>Contrôle des appareils, en secondes
          <input name="poll_interval_s" type="number" min="10" max="3600" value="${esc(settings.poll_interval_s ?? 30)}">
        </label>
        <label>Délai des pages et des ports, en secondes
          <input name="http_timeout_s" type="number" min="1" max="6" value="${esc(settings.http_timeout_s ?? 2)}">
        </label>
        <p class="help">Un appareil qui redémarre reçoit souvent une nouvelle adresse. La console le reconnaît à sa carte réseau et met la fiche à jour toute seule. Les commandes du tableau, appel ou image, se règlent sur chaque fiche et marchent quelle que soit la marque.</p>
        <button class="btn primary" type="submit">Enregistrer les réglages</button>
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
  root.innerHTML = `
    <div class="backdrop" data-action="close-modal">
      <div class="panel stack" data-action="stop">
      <form class="stack" id="device-form" data-form="device">
        <h2>${device.id ? "Fiche appareil" : "Nouvel appareil"}</h2>
        <label>Nom <input name="name" value="${esc(device.name)}" required></label>
        <div class="ip-box">
          <label>Adresse IP
            <input name="ip" class="mono" value="${esc(device.ip)}" spellcheck="false" autocomplete="off" required>
          </label>
          <p class="help">Cette adresse est testée à l'enregistrement. Si l'appareil redémarre et change d'adresse, la carte réseau permet de le retrouver. L'historique garde les changements.</p>
        </div>
        <div class="grid-2">
          <label>Type <select name="type_id">${options(state.types, device.type_id)}</select></label>
          <label>Pièce <select name="room_id">${options(state.rooms, device.room_id, "Non classé")}</select></label>
        </div>
        <div class="grid-3">
          <label>Liaison <select name="protocol">${protocolOptions(device.protocol || "ping")}</select></label>
          <label>Port <input name="port" class="mono" inputmode="numeric" value="${esc(device.port ?? "")}" placeholder="selon la liaison"></label>
          <label>Chemin <input name="http_path" value="${esc(device.http_path || "/")}" spellcheck="false"></label>
        </div>
        <label>Adresse MAC <input name="mac" class="mono" value="${esc(device.mac || "")}" spellcheck="false" placeholder="facultative, sert à suivre l'appareil s'il change d'adresse"></label>
        <input type="hidden" name="hostname" value="${esc(device.hostname || "")}">
        <label>Note <textarea name="notes" rows="3">${esc(device.notes || "")}</textarea></label>
        <p id="form-error" class="form-error" ${state.modal.error ? "" : "hidden"}>${esc(state.modal.error || "")}</p>
        <p id="test-result" class="quiet">${state.modal.test ? esc(describeCheck(state.modal.test)) : ""}</p>
        <div class="actions">
          <button class="btn primary" type="submit">${state.modal.conflict ? "Enregistrer quand même" : "Enregistrer et tester"}</button>
          <button class="btn" type="button" data-action="test-link">Tester sans enregistrer</button>
          <button class="btn" type="button" data-action="open-page" ${pageable ? "" : "hidden"}>Ouvrir la page</button>
          ${device.id ? `<button class="btn danger" type="button" data-action="delete-device" data-id="${device.id}">Retirer de la liste</button>` : ""}
          <button class="btn" type="button" data-action="close-modal">Fermer</button>
        </div>
      </form>
      <section id="commands" class="stack">${commandsInner(device)}</section>
      ${history.length ? `<div><h2>Historique des adresses</h2><ul class="history">${history.map(historyItem).join("")}</ul></div>` : ""}
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
    return `<p class="help">Enregistre l'appareil, puis ajoute ses commandes. Un appel HTTP ou un flux image, à adapter au chemin que l'appareil attend.</p>`;
  }
  const rows = (device.actions || []).map((item) => `
    <article class="command stack" data-command="${item.id}">
      <div class="grid-3">
        <label>Nom <input class="cmd-label" value="${esc(item.label)}"></label>
        <label>Type
          <select class="cmd-kind">
            <option value="http"${item.kind === "http" ? " selected" : ""}>Appel</option>
            <option value="stream"${item.kind === "stream" ? " selected" : ""}>Flux</option>
          </select>
        </label>
        <label>Méthode <select class="cmd-method">${methodOptions(item.kind, item.method)}</select></label>
      </div>
      <label>Chemin sur l'appareil <input class="cmd-path mono" value="${esc(item.path)}" spellcheck="false"></label>
      <label class="cmd-body-label"${item.kind === "stream" ? " hidden" : ""}>Corps, facultatif <input class="cmd-body mono" value="${esc(item.body || "")}" spellcheck="false"></label>
      <details>
        <summary>Accès, si l'appareil en demande un</summary>
        <div class="grid-2">
          <label>Identifiant <input class="cmd-user" value="${esc(item.auth_user || "")}" autocomplete="off"></label>
          <label>Mot de passe <input class="cmd-pass" type="password" value="${esc(item.auth_pass || "")}" autocomplete="off"></label>
        </div>
      </details>
      <div class="actions">
        <button type="button" class="btn" data-action="save-command">Enregistrer la commande</button>
        ${item.kind === "stream"
          ? `<button type="button" class="btn" data-action="show-stream" data-id="${device.id}" data-command="${item.id}" data-method="${esc(item.method)}" data-label="${esc(item.label)}">Voir</button>`
          : `<button type="button" class="btn" data-action="run-action" data-id="${device.id}" data-command="${item.id}">Lancer</button>`}
        <button type="button" class="btn" data-action="delete-command">Retirer</button>
      </div>
    </article>
  `).join("");
  return `
    <h2>Commandes</h2>
    <p class="help">Même formulaire pour toutes les marques. Le modèle couvre la maison, et tu changes le chemin pour qu'il corresponde à l'appareil.</p>
    <div class="inline">
      <select id="preset">${presetOptions()}</select>
      <button type="button" class="btn" data-action="apply-preset">Ajouter le modèle</button>
      <button type="button" class="btn" data-action="add-command">Commande vide</button>
    </div>
    ${rows || `<p class="quiet">Aucune commande pour l'instant.</p>`}
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
      rows.innerHTML = list.map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil ne correspond.</p>`;
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
        <p class="help">Si l'image reste vide, ouvre la fiche et adapte le chemin du flux.</p>
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
  const label = STATE_LABEL[result.state] || "Contrôle";
  const latency = result.latency_ms != null ? `, ${result.latency_ms} ms` : "";
  return `${label}${latency}. ${result.detail || ""}`;
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
    if (check.state === "online") toast("Enregistré. Liaison établie.");
    else if (check.state === "degraded") toast("Enregistré. L'adresse répond, le service demandé non.");
    else toast("Enregistré. L'appareil ne répond pas pour le moment.");
  } catch (error) {
    if (error.status === 409) {
      state.modal.conflict = true;
      state.modal.error = `${error.message} Vous pouvez enregistrer quand même.`;
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
    toast("Cochez au moins un appareil.");
    return;
  }
  try {
    const result = await api("/api/scan/apply", { method: "POST", body: { creates, updates, force: false } });
    toast(`${result.created.length} ajouté${result.created.length > 1 ? "s" : ""}, ${result.updated.length} adresse${result.updated.length > 1 ? "s" : ""} mise${result.updated.length > 1 ? "s" : ""} à jour.`);
    state.scan = await api("/api/scan");
    await hydrate();
    render();
  } catch (error) {
    if (error.status === 409 && confirm(error.message + " Enregistrer quand même ?")) {
      try {
        const result = await api("/api/scan/apply", { method: "POST", body: { creates, updates, force: true } });
        toast(result.created.length + " ajoutés, " + result.updated.length + " adresses mises à jour.");
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
        if (rows) rows.innerHTML = filteredDevices().map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil ne correspond.</p>`;
      }
    } else if (state.view === "scan" && state.scanning) {
      const scan = await api("/api/scan");
      const was = state.scan?.state;
      state.scan = scan;
      const box = document.getElementById("scan-form");
      if (scan.state === "running" && box) {
        const phase = scan.phase === "ports" ? "Vérification des services" : "Ping";
        const width = scan.total ? Math.min(100, Math.round((scan.done / scan.total) * 100)) : 0;
        let progress = box.querySelector(".progress");
        if (!progress) {
          render();
          return;
        }
        const label = box.querySelector(".progress").previousElementSibling;
        if (label) label.textContent = `${phase} ${scan.done} / ${scan.total}. ${scan.responding || 0} répondant${scan.responding > 1 ? "s" : ""}.`;
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
    try {
      const result = await finishCommand(await api(`/api/devices/${el.dataset.id}/actions/${el.dataset.command}/run`, { method: "POST", body: {} }));
      toast(result.detail || "Commande envoyée.");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "show-stream") {
    if (location.hostname.endsWith(".vercel.app")) {
      toast("L'image se regarde sur le Wi-Fi de la maison, depuis l'ordinateur où maMaison est ouvert.");
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
      toast("Commande enregistrée.");
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "delete-command") {
    const row = el.closest(".command");
    if (!confirm("Retirer cette commande ?")) return;
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
    if (!confirm("Retirer « " + label + " » de la liste ? L'appareil reste allumé sur le réseau.")) return;
    await api(`/api/devices/${device.id}`, { method: "DELETE" });
    state.modal = null;
    await refreshView();
    toast("Appareil retiré de la liste.");
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
        toast("Indiquez un réseau privé jusqu'au /22, par exemple 192.168.1.0/24.");
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
      toast("Réglages enregistrés.");
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
      rows.innerHTML = list.map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil ne correspond.</p>`;
    }
  }
  if (event.target.id === "subnet") {
    state.scanDraft = event.target.value;
    const estimate = document.getElementById("estimate");
    const count = hostEstimate(event.target.value);
    if (estimate) {
      estimate.textContent = count == null
        ? "Maximum : un réseau /22, par exemple 192.168.1.0/24."
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
      rows.innerHTML = list.map((device) => deviceRow(device)).join("") || `<p class="empty">Aucun appareil ne correspond.</p>`;
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
    foot.innerHTML = code
      ? `Maison ${esc(code)}. <a href="${RELEASE}">Télécharger le programme</a>`
      : `Le code vient de l'ordinateur de la maison. <a href="${RELEASE}">Télécharger</a>`;
    return;
  }
  if (state.houseCode) foot.textContent = `Code de la maison : ${state.houseCode}`;
}

function onHouseComputer() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

function needsProgram(dashboard) {
  return Boolean(dashboard && dashboard.house && !dashboard.house.at);
}

function renderInstall() {
  state.view = "install";
  paintPlace();
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Installation";
  viewEl().innerHTML = `
    <article class="card login-card">
      <h2>Installer le programme</h2>
      <p>Chaque maison se crée sur place. Installe maMaison sur un ordinateur qui est sur le Wi-Fi de cette maison, choisis un mot de passe, et laisse la fenêtre ouverte.</p>
      <p>Le programme affiche un code. Sur le téléphone, entre ce code et le mot de passe choisi là-bas.</p>
      <a class="btn primary" href="${RELEASE}">Télécharger maMaison pour Windows</a>
      <p class="help">Dès que l'ordinateur est relié, le tableau de bord s'affiche ici.</p>
    </article>`;
}

function renderCreate() {
  state.view = "link";
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Nouvelle maison";
  viewEl().innerHTML = `
    <article class="card login-card">
      <h2>Créer cette maison</h2>
      <p>Cet ordinateur est sur le Wi-Fi. Choisis le mot de passe que la famille tapera sur le téléphone. Il n'appartient qu'à cette maison.</p>
      <form id="link-form">
        <label>Mot de passe
          <input type="password" name="password" autocomplete="new-password" required minlength="6">
        </label>
        <label>Encore le mot de passe
          <input type="password" name="confirm" autocomplete="new-password" required minlength="6">
        </label>
        <p class="form-error" id="link-error"></p>
        <button class="btn primary" type="submit">Créer la maison</button>
      </form>
    </article>`;
  document.getElementById("link-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirm") || "");
    const box = document.getElementById("link-error");
    if (password.length < 6) {
      if (box) box.textContent = "Le mot de passe doit contenir au moins 6 caractères.";
      return;
    }
    if (password !== confirm) {
      if (box) box.textContent = "Les deux mots de passe sont différents.";
      return;
    }
    try {
      const linked = await api("/api/link", { method: "POST", body: { password } });
      renderReady(linked.house || "");
    } catch (error) {
      if (box) box.textContent = error.message;
    }
  });
}

function renderReady(code) {
  state.view = "link";
  state.houseCode = code;
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Maison créée";
  viewEl().innerHTML = `
    <article class="card login-card">
      <h2>Cette maison a son code</h2>
      <p>Sur le téléphone, ouvre la page. Entre ce code et le mot de passe que tu viens de choisir. Laisse cette fenêtre ouverte.</p>
      <p class="house-code">${esc(code)}</p>
      <button type="button" class="btn primary" id="open-console">Ouvrir la console</button>
    </article>`;
  document.getElementById("open-console").addEventListener("click", async () => {
    state.view = "dashboard";
    await boot();
  });
}

function renderLink() {
  renderCreate();
}

function renderLogin() {
  state.view = "login";
  paintPlace();
  const title = document.getElementById("view-title");
  if (title) title.textContent = "Accès";
  viewEl().innerHTML = `
    <article class="card login-card">
      <h2>Entrer dans la maison</h2>
      <p>Le code est affiché par le programme ouvert sur l'ordinateur de cette maison. Le mot de passe est celui choisi à ce moment-là.</p>
      <form id="login-form">
        <label>Code de la maison
          <input name="house" autocapitalize="characters" autocomplete="off" required>
        </label>
        <label>Mot de passe
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <p class="form-error" id="login-error"></p>
        <button class="btn primary" type="submit">Entrer</button>
      </form>
    </article>`;
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/login", { method: "POST", body: { house: form.get("house"), password: form.get("password") } });
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
    if (job.done) return job.result || { detail: "Commande envoyée." };
  }
  return { detail: "La maison n'a pas répondu. L'ordinateur est-il allumé, avec la fenêtre noire ouverte ?" };
}

async function boot() {
  try {
    if (onHouseComputer()) {
      const link = await api("/api/link");
      state.houseCode = link.house || state.houseCode || "";
      if (!link.linked) {
        renderCreate();
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
    viewEl().innerHTML = `<p class="empty">${esc(error.message)} Rechargez la page. Si la fenêtre noire est fermée, relancez lancer.bat.</p>`;
  }
}

boot();
