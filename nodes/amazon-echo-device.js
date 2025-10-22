const WebSocket = require("ws");

module.exports = function (RED) {
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name       = config.name || "";
    node.haServer   = RED.nodes.getNode(config.haServer) || null; // required in HTML
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

  // ---------- Admin endpoints for editor dropdowns ----------
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/devices",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const serverId = req.query.server;
        if (!serverId) return res.status(400).send("Missing server id");
        const haServer = RED.nodes.getNode(serverId);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { baseUrl, token } = getHaUrlAndToken(haServer);
        if (!baseUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

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

  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entities",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const serverId = req.query.server;
        if (!serverId) return res.status(400).send("Missing server id");
        const haServer = RED.nodes.getNode(serverId);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { baseUrl, token } = getHaUrlAndToken(haServer);
        if (!baseUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

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

  // ---------- Helpers ----------
  function getHaUrlAndToken(haServer) {
    const baseUrl =
      (typeof haServer.getUrl === "function" && haServer.getUrl()) ||
      haServer.url ||
      (haServer.config && haServer.config.url) ||
      null;

    const token =
      (haServer.credentials && (haServer.credentials.access_token || haServer.credentials.token)) ||
      null;

    return { baseUrl, token };
  }

  function wsCall(wsUrl, token, msg) {
    return new Promise((resolve, reject) => {
      const WebSocket = require("ws");
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
