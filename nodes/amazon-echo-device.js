// nodes/amazon-echo-device.js
// Amazon Echo Device (HA Entities) — Filters (Area/Label/Domain) + Device/Entity + modes/attrs preview
const WebSocket = require("ws");

module.exports = function (RED) {
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name       = config.name || "";
    node.haServer   = RED.nodes.getNode(config.haServer) || null; // selected HA server config node
    node.haAreaId   = config.haAreaId || "";   // new
    node.haLabelId  = config.haLabelId || "";  // new
    node.haDomain   = config.haDomain || "";   // new
    node.haDeviceId = config.haDeviceId || "";
    node.haEntityId = config.haEntityId || "";
    node.deviceid   = node.deviceid || config.deviceid || null;

    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || function(){};

      try {
        const nodeDeviceId = node.deviceid || node.id;
        if (msg && msg.deviceid && msg.deviceid === nodeDeviceId) {
          if (typeof msg.payload !== "object" || msg.payload === null) {
            msg.payload = { value: msg.payload };
          }
          msg.payload.haDeviceId = node.haDeviceId || "";
          msg.payload.haEntityId = node.haEntityId || "";
          _send(msg);
          return _done();
        }
        _send(msg);
        _done();
      } catch (err) {
        node.error(err, msg);
        _done(err);
      }
    });

    node.on("close", (done) => done());
  }

  RED.nodes.registerType("amazon-echo-device-ha-entities", AmazonEchoDeviceNode);

  // ---------- Admin endpoints ----------

  // Filters: areas, labels, domains, and total device count
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/filters",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const [areas, labels, devices, entities] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/area_registry/list" }),
          wsCall(wsUrl, token, { type: "config/label_registry/list" }).catch(() => []), // label registry may not exist on older HA
          wsCall(wsUrl, token, { type: "config/device_registry/list" }),
          wsCall(wsUrl, token, { type: "config/entity_registry/list" })
        ]);

        // Domains list from entities
        const domainCounts = {};
        (entities || []).forEach(e => {
          const domain = (e && e.entity_id && e.entity_id.split(".")[0]) || null;
          if (!domain) return;
          domainCounts[domain] = (domainCounts[domain] || 0) + 1;
        });
        const domains = Object.keys(domainCounts).sort().map(d => ({ domain: d, count: domainCounts[d] }));

        res.json({
          total_devices: Array.isArray(devices) ? devices.length : 0,
          areas: (areas || []).map(a => ({ area_id: a.area_id, name: a.name || a.area_id })),
          labels: (labels || []).map(l => ({ label_id: l.label_id, name: l.name || l.label_id })),
          domains
        });
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Devices list (filtered by area/label/domain)
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/devices",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const [devices, entities] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/device_registry/list" }),
          wsCall(wsUrl, token, { type: "config/entity_registry/list" })
        ]);

        const areaId  = (req.query.area  || "").trim();
        const labelId = (req.query.label || "").trim();
        const domain  = (req.query.domain|| "").trim();

        // Map entities by device_id for filters (label/domain/area via entity takes precedence)
        const entsByDevice = new Map();
        (entities || []).forEach(e => {
          if (!e || !e.device_id) return;
          if (!entsByDevice.has(e.device_id)) entsByDevice.set(e.device_id, []);
          entsByDevice.get(e.device_id).push(e);
        });

        const filtered = (devices || []).filter(d => {
          const ents = entsByDevice.get(d.id) || [];

          // Area filter: match device.area_id OR any entity.area_id
          if (areaId) {
            const matchArea = (d.area_id === areaId) || ents.some(e => e.area_id === areaId);
            if (!matchArea) return false;
          }

          // Label filter: entities may carry labels; device usually doesn't
          if (labelId) {
            const matchLabel = ents.some(e => Array.isArray(e.labels) && e.labels.includes(labelId));
            if (!matchLabel) return false;
          }

          // Domain filter: match if the device has at least one entity with that domain
          if (domain) {
            const matchDomain = ents.some(e => e.entity_id && e.entity_id.split(".")[0] === domain);
            if (!matchDomain) return false;
          }

          return true;
        });

        const out = filtered.map(d => {
          const name = d.name_by_user || d.name || [d.manufacturer, d.model].filter(Boolean).join(" ") || d.id;
          return { id: d.id, name, displayName: name };
        });

        res.json(out);
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Entities (optionally by device id)
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entities",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const all = await wsCall(wsUrl, token, { type: "config/entity_registry/list" });
        const deviceId = (req.query.device || "").trim();

        const filtered = (all || [])
          .filter(e => !deviceId || e.device_id === deviceId)
          .map(e => ({
            entity_id: e.entity_id,
            name: e.name || e.original_name || "",
            displayName: e.name || e.original_name || e.entity_id
          }));

        res.json(filtered);
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Entity info (state + attributes + detected modes)
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entity_info",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        const entityId = (req.query.entity || "").trim();
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");
        if (!entityId) return res.status(400).send("Missing entity id");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const states = await wsCall(wsUrl, token, { type: "get_states" });
        const st = Array.isArray(states) ? states.find(s => s && s.entity_id === entityId) : null;

        const attributes = (st && st.attributes) ? st.attributes : {};
        const detected_modes = detectModes(attributes);

        res.json({
          entity_id: entityId,
          state: st ? st.state : null,
          attributes,
          detected_modes
        });
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // ---------- Helpers ----------
  function resolveHaServer(RED, serverId) {
    let s = null;
    if (serverId) {
      s = RED.nodes.getNode(serverId) || null;
      const { wsUrl, token } = getHaUrlAndToken(RED, s, serverId);
      if (wsUrl && token) return s;
    }
    const configs = [];
    if (RED.nodes.eachConfig) RED.nodes.eachConfig(n => configs.push(n));
    const serverCfgs = configs.filter(n => n.type === "server");
    for (const cfg of serverCfgs) {
      const inst = RED.nodes.getNode(cfg.id);
      const { wsUrl, token } = getHaUrlAndToken(RED, inst, cfg.id);
      if (wsUrl && token) return inst;
    }
    return null;
  }

  // Mirror HA add-on auth: supervisor proxy when available; otherwise LLAT+URL
  function getHaUrlAndToken(RED, haServer, serverId) {
    if (!haServer) return { baseUrl: null, token: null, wsUrl: null };

    const addonMode =
      !!process.env.SUPERVISOR_TOKEN ||
      haServer?.config?.addon === true ||
      haServer?.addon === true ||
      haServer?.useAddon === true;

    if (addonMode && process.env.SUPERVISOR_TOKEN) {
      return {
        baseUrl: "http://supervisor/core",
        wsUrl: "ws://supervisor/core/websocket",
        token: process.env.SUPERVISOR_TOKEN
      };
    }

    const baseUrl =
      (typeof haServer.getUrl === "function" && haServer.getUrl()) ||
      haServer?.url ||
      haServer?.config?.url ||
      haServer?.client?.websocketUrl ||
      haServer?.client?.baseUrl ||
      null;

    const credsFromApi = serverId ? (RED.nodes.getCredentials(serverId) || null) : null;
    const instCreds    = haServer && haServer.credentials ? haServer.credentials : null;

    const token =
      credsFromApi?.access_token ||
      credsFromApi?.token ||
      instCreds?.access_token ||
      instCreds?.token ||
      haServer?.client?.auth?.access_token ||
      haServer?.client?.token ||
      haServer?.connection?.options?.access_token ||
      null;

    let wsUrl = null;
    if (baseUrl) {
      wsUrl = String(baseUrl)
        .replace(/^http:/i, "ws:")
        .replace(/^https:/i, "wss:");
      if (!/\/api\/websocket$/i.test(wsUrl)) {
        wsUrl = wsUrl.replace(/\/+$/,"") + "/api/websocket";
      }
    }
    return { baseUrl, token, wsUrl };
  }

  function detectModes(attrs) {
    const out = {};
    if (!attrs || typeof attrs !== "object") return out;

    const candidates = [
      "hvac_modes", "preset_modes", "fan_modes", "swing_modes", "swing_mode_list",
      "speed_list", "effect_list", "source_list", "input_source_list",
      "supported_color_modes", "color_modes", "modes", "supported_features_list"
    ];
    candidates.forEach(k => {
      const v = attrs[k];
      if (Array.isArray(v) && v.length) out[k] = v;
    });
    Object.keys(attrs).forEach(k => {
      if ((/_modes$|_list$/i).test(k) && Array.isArray(attrs[k]) && attrs[k].length) {
        if (!out[k]) out[k] = attrs[k];
      }
    });
    return out;
  }

  function wsCall(wsUrl, token, msg) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let nextId = 1;

      function send(obj) { ws.send(JSON.stringify(obj)); }

      ws.on("open", () => {
        ws.once("message", (raw) => {
          let hello; try { hello = JSON.parse(raw); } catch (e) { return reject(new Error("Invalid HA hello")); }
          if (hello.type !== "auth_required") return reject(new Error("Unexpected HA hello"));
          send({ type: "auth", access_token: token });

          ws.once("message", (raw2) => {
            let auth; try { auth = JSON.parse(raw2); } catch (e) { return reject(new Error("Invalid HA auth response")); }
            if (auth.type !== "auth_ok") return reject(new Error("HA auth failed"));

            const id = nextId++;
            send(Object.assign({ id }, msg));

            ws.on("message", (raw3) => {
              let resp; try { resp = JSON.parse(raw3); } catch (e) { return; }
              if (resp.id === id) {
                ws.close();
                if (resp.success === false) return reject(new Error((resp.error && resp.error.message) || "HA command failed"));
                resolve(resp.result || []);
              }
            });
          });
        });
      });
      ws.on("error", reject);
    });
  }
};
