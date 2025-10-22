// nodes/amazon-echo-device.js
const WebSocket = require("ws");

module.exports = function (RED) {
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Existing props
    node.name = config.name || "";

    // NEW persisted linkage (survives reboots in flow file)
    node.haServer   = RED.nodes.getNode(config.haServer) || null; // HA "server" config node
    node.haDeviceId = config.haDeviceId || "";
    node.haEntityId = config.haEntityId || "";

    // Compat: some variants store a deviceid for the echo device itself
    node.deviceid = node.deviceid || config.deviceid || null;

    // Runtime: enhance outgoing payload when this message targets this node's echo device
    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || function(){};
      const nodeDeviceId = node.deviceid || node.id;

      try {
        if (msg && msg.deviceid && nodeDeviceId === msg.deviceid) {
          // Non-breaking: add HA linkage into payload
          if (typeof msg.payload !== "object" || msg.payload === null) {
            msg.payload = { value: msg.payload };
          }
          msg.payload.haDeviceId = node.haDeviceId || "";
          msg.payload.haEntityId = node.haEntityId || "";

          _send(msg);
          return _done();
        }

        // otherwise pass through
        _send(msg);
        _done();
      } catch (err) {
        node.error(err, msg);
        _done(err);
      }
    });

    node.on("close", (done) => done());
  }

  RED.nodes.registerType("amazon-echo-device", AmazonEchoDeviceNode);

  // ---------------------- Editor Admin Endpoints ----------------------
  // These power the dropdowns in the editor and run only in the editor context.

  // GET /amazon-echo/ha/devices?server=<configNodeId>
  RED.httpAdmin.get(
    "/amazon-echo/ha/devices",
    RED.auth.needsPermission("flows.read"),
    async function (req, res) {
      try {
        const serverId = req.query.server;
        if (!serverId) return res.json([]);

        const haServer = RED.nodes.getNode(serverId);
        if (!haServer) return res.json([]);

        // Reuse URL+token from the HA websocket server config node
        const baseUrl =
          (typeof haServer.getUrl === "function" && haServer.getUrl()) ||
          haServer.url ||
          (haServer.config && haServer.config.url);
        const token =
          (haServer.credentials && (haServer.credentials.access_token || haServer.credentials.token)) ||
          null;

        if (!baseUrl || !token) return res.status(400).send("Select a valid Home Assistant server node");

        const wsUrl = baseUrl.replace(/^http/i, "ws") + "/api/websocket";
        const devices = await wsCall(wsUrl, token, { type: "config/device_registry/list" });

        // Provide a displayName for the UI (showing a human-friendly name)
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

  // GET /amazon-echo/ha/entities?server=<configNodeId>&device=<deviceId>
  RED.httpAdmin.get(
    "/amazon-echo/ha/entities",
    RED.auth.needsPermission("flows.read"),
    async function (req, res) {
      try {
        const serverId = req.query.server;
        const deviceId = req.query.device;
        if (!serverId || !deviceId) return res.json([]);

        const haServer = RED.nodes.getNode(serverId);
        if (!haServer) return res.json([]);

        const baseUrl =
          (typeof haServer.getUrl === "function" && haServer.getUrl()) ||
          haServer.url ||
          (haServer.config && haServer.config.url);
        const token =
          (haServer.credentials && (haServer.credentials.access_token || haServer.credentials.token)) ||
          null;

        if (!baseUrl || !token) return res.status(400).send("Select a valid Home Assistant server node");

        const wsUrl = baseUrl.replace(/^http/i, "ws") + "/api/websocket";
        const entities = await wsCall(wsUrl, token, { type: "config/entity_registry/list" });

        // Provide displayName preferring friendly name; fallback to original_name or entity_id
        const filtered = (entities || [])
          .filter((e) => e.device_id === deviceId)
          .map((e) => {
            const displayName = e.name || e.original_name || e.entity_id;
            return {
              entity_id: e.entity_id,
              name: e.name || e.original_name || "",
              displayName
            };
          });

        res.json(filtered);
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // ---------------------- Minimal HA WS helper ----------------------
  function wsCall(wsUrl, token, msg) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let nextId = 1;

      function send(obj) {
        ws.send(JSON.stringify(obj));
      }

      ws.on("open", () => {
        // 1) hello
        ws.once("message", (raw) => {
          let hello;
          try { hello = JSON.parse(raw); } catch (e) { return reject(new Error("Invalid HA hello")); }
          if (hello.type !== "auth_required") return reject(new Error("Unexpected HA hello"));

          // 2) auth
          send({ type: "auth", access_token: token });

          ws.once("message", (raw2) => {
            let auth;
            try { auth = JSON.parse(raw2); } catch (e) { return reject(new Error("Invalid HA auth response")); }
            if (auth.type !== "auth_ok") return reject(new Error("HA auth failed"));

            // 3) actual call
            const id = nextId++;
            send(Object.assign({ id }, msg));

            ws.on("message", (raw3) => {
              let resp;
              try { resp = JSON.parse(raw3); } catch (e) { return; }
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
