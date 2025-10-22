// nodes/amazon-echo-device.js
// Amazon Echo Device (HA Entities) — exposes Device/Entity dropdowns (entity list filtered by device)

const WebSocket = require("ws");

module.exports = function (RED) {
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name       = config.name || "";
    node.haServer   = RED.nodes.getNode(config.haServer) || null; // hidden UI, auto-picked
    node.haDeviceId = config.haDeviceId || ""; // device_id from HA device registry
    node.haEntityId = config.haEntityId || ""; // entity_id from HA entity registry

    // (Optional) echo device's own id if your flow uses it
    node.deviceid = node.deviceid || config.deviceid || null;

    // Enhance matching payloads with HA linkage, non-breaking
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

  // ---------------------- Admin Endpoints (Editor) ----------------------
  // These populate the dropdowns. They run only in the Editor and do not affect runtime.

  // GET /amazon-echo-ha-entities/devices
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/devices",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const { baseUrl, token } = getHaAuthFromAnyServer(RED);
        if (!baseUrl || !token) return res.status(400).send("Home Assistant server config node not found");

        const wsUrl = baseUrl.replace(/^http/i, "ws") + "/api/websocket";
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

  // GET /amazon-echo-ha-entities/entities?device=<device_id>
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entities",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const { baseUrl, token } = getHaAuthFromAnyServer(RED);
        if (!baseUrl || !token) return res.status(400).send("Home Assistant server config node not found");

        const wsUrl = baseUrl.replace(/^http/i, "ws") + "/api/websocket";
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

  // ---------------------- Helpers ----------------------

  function getHaAuthFromAnyServer(RED) {
    // Try to find any HA websocket "server" config node (from node-red-contrib-home-assistant-websocket)
    const servers = [];
    if (RED.nodes.eachConfig) {
      RED.nodes.eachConfig((n) => { if (n.type === "server") servers.push(n); });
    }
    const haServer = servers[0] ? RED.nodes.getNode(servers[0].id) : null;

    const baseUrl =
      (haServer && typeof haServer.getUrl === "function" && haServer.getUrl()) ||
      (haServer && (haServer.url || (haServer.config && haServer.config.url))) || null;

    const token =
      (haServer && haServer.credentials && (haServer.credentials.access_token || haServer.credentials.token)) || null;

    return { baseUrl, token };
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
