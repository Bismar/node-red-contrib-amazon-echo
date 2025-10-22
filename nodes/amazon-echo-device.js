// nodes/amazon-echo-device.js
// Amazon Echo Device (HA Entities) — Device/Entity dropdowns with HA server selection
const WebSocket = require("ws");

module.exports = function (RED) {
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name       = config.name || "";
    node.haServer   = RED.nodes.getNode(config.haServer) || null; // selected HA server config node
    node.haDeviceId = config.haDeviceId || "";
    node.haEntityId = config.haEntityId || "";
    node.deviceid   = node.deviceid || config.deviceid || null;

    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || function(){};

      try {
        const nodeDeviceId = node.deviceid || node.id;
        if (msg && msg.deviceid && msg.deviceid === nodeDeviceId) {
          // Non-breaking: enrich payload with HA linkage
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

  // ---------- Admin endpoints for editor dropdowns ----------
  // GET /amazon-echo-ha-entities/devices?server=<id>
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/devices",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(haServer);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const devices = await wsCall(wsUrl, token, { type: "config/device_registry/list" });
        const out = (devices || []).map((d) => {
          const name = d.name_by_user || d.name || [d.manufacturer, d.model].filter(Boolean).join(" ") || d.id;
          return { id: d.id, name, displayName: name };
        });
        res.json(out);
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // GET /amazon-echo-ha-entities/entities?server=<id>&device=<device_id?>
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entities",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(haServer);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const all = await wsCall(wsUrl, token, { type: "config/entity_registry/list" });

        const deviceId = req.query.device || "";
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

  // ---------- Helpers ----------

  // Prefer the server id passed from the UI; if missing/invalid or lacking creds,
  // auto-pick the first HA server config that exposes a usable URL+token.
  function resolveHaServer(RED, serverId) {
    let s = null;
    if (serverId) {
      s = RED.nodes.getNode(serverId) || null;
      const { wsUrl, token } = getHaUrlAndToken(s);
      if (wsUrl && token) return s; // good to go
    }
    // fallback: scan all config nodes for type "server"
    const configs = [];
    if (RED.nodes.eachConfig) RED.nodes.eachConfig(n => configs.push(n));
    const serverCfg = configs.find(n => n.type === "server");
    if (!serverCfg) return null;
    const candidate = RED.nodes.getNode(serverCfg.id);
    const { wsUrl, token } = getHaUrlAndToken(candidate);
    return (wsUrl && token) ? candidate : null;
  }

  function getHaUrlAndToken(haServer) {
    if (!haServer) return { baseUrl: null, token: null, wsUrl: null };

    // Try multiple known places; different versions store these differently
    const baseUrl =
      (typeof haServer.getUrl === "function" && haServer.getUrl()) ||
      haServer?.url ||
      haServer?.config?.url ||
      haServer?.client?.websocketUrl ||
      haServer?.client?.baseUrl ||
      null;

    const token =
      haServer?.credentials?.access_token ||
      haServer?.credentials?.token ||
      haServer?.client?.auth?.access_token ||
      haServer?.client?.token ||
      haServer?.connection?.options?.access_token ||
      null;

    // Normalize to ws(s) + /api/websocket
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
